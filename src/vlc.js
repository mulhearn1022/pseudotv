const Router = require('express').Router
const spawn = require('child_process').spawn
const request = require('request')
const config = require('config-yml')

const xmltv = require('./xmltv')

module.exports = vlcRouter

function vlcRouter(client) {
    var router = Router()
    var inUse = false
    router.get('/video', (req, res) => {
        if (inUse)
            return res.status(409).send("Error: Another user is currently viewing a stream. One one active stream is allowed.")
        inUse = true
        var channel = req.query.channel
        if (!channel) {
            inUse = false
            res.status(400).send("Error: No channel queried")
            return
        }
        channel = channel.split('?')[0]
        
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-disposition': 'attachment; filename=video.ts'
        })
        startStreaming(channel, res)
    })

    return router

    function startStreaming(channel, res) {
        var programs = xmltv.readXMLPrograms()
        var startPos = -1
        var programIndex = -1
        var channelExists = false
        for (var i = 0; i < programs.length; i++) {
            var date = new Date()
            if (programs[i].channel == channel) {
                channelExists = true
                if (programs[i].start <= date && programs[i].stop >= date) {
                    startPos = date.getTime() - programs[i].start.getTime()
                    programIndex = i
                    break
                }
            }
        }
        // End session if any errors.
        if (!channelExists) {
            inUse = false
            res.status(403).send(`Error: Channel doesn't exist. Channel: ${channel}`)
            return
        }
        if (programIndex === -1) {
            inUse = false
            res.status(403).send(`Error: No scheduled programming available. Channel: ${channel}`)
            return
        }
        if (startPos === -1) {
            inUse = false
            res.status(403).send(`Error: How the fuck did you get here?. Channel: ${channel}`)
            return
        }
        // Query plex for current program
        client.Get(programs[programIndex].key, (result) => {
            if (result.err) {
                inUse = false
                res.status(403).send(`Error: Failed to fetch program info from Plex`)
                return
            }
            var fetchedItem = result.result.MediaContainer.Metadata[0]
            // Transcode it
            client.Transcode(fetchedItem, startPos, (result) => {
                if (result.err) {
                    inUse = false
                    res.status(403).send(`Error: Failed to add program to playQueue`)
                    return
                }
                // Update server timeline every 10 seconds
                var stream = result.result
                var msElapsed = startPos
                var timelineInterval = setInterval(() => {
                    stream.update(msElapsed)
                    msElapsed += 10000
                }, 10000)
                var args = [
                    stream.url,
                    `--start-time=${(startPos + config.VLC_OPTIONS.DELAY) / 1000}`,
                    `--sout=#http{mux=ts,dst=:${config.VLC_OPTIONS.PORT}/}`
                ]
                if (config.VLC_OPTIONS.HIDDEN)
                    args.push("--intf=dummy")
                // Fire up VLC
                var vlc = spawn(config.VLC_OPTIONS.PATH, args)
                // Wait for VLC to open before we request anything.
                setTimeout(() => {
                    request(`http://${config.HOST}:${config.VLC_OPTIONS.PORT}/`)
                    .on('error', (err) => {
                        vlc.kill()
                        if (err.code === 'ECONNRESET') {
                            var end = programs[programIndex].stop
                            var now = new Date()
                            var timeUntilDone = end.valueOf() - now.valueOf()
                            timeUntilDone = timeUntilDone > 0 ? timeUntilDone : 0
                            setTimeout(() => {
                                res.removeListener('close', httpEnd)
                                startStreaming(channel, res)
                            }, timeUntilDone)
                        }
                    })
                    .on('data', (chunk) => {
                        res.write(chunk)
                    })
                    .on("complete", () => {
                        vlc.kill()
                        var end = programs[programIndex].stop
                        var now = new Date()
                        var timeUntilDone = end.valueOf() - now.valueOf()
                        timeUntilDone = timeUntilDone > 0 ? timeUntilDone : 0
                        setTimeout(() => {
                            res.removeListener('close', httpEnd)
                            startStreaming(channel, res)
                        }, timeUntilDone)
                    })
                }, config.VLC_OPTIONS.DELAY)
                
                // When the http session ends: kill vlc
                var httpEnd = function () {
                    vlc.kill()
                    inUse = false
                }
                res.on('close', httpEnd)

                vlc.on('close', (code) => {
                    clearInterval(timelineInterval)
                    stream.stop()
                    if (code !== 0 && !res.headersSent) {
                        res.status(400).send(`Error: VLC closed unexpectedly`)
                    }
                })
            })
        })

    }
}