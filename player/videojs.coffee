sortSources = (sources) ->
    if not sources
        console.error('sortSources() called with null source list')
        return []

    qualities = ['2160', '1440', '1080', '720', '540', '480', '360', '240']
    pref = String(USEROPTS.default_quality)
    if USEROPTS.default_quality == 'best'
        pref = '2160'
    idx = qualities.indexOf(pref)
    if idx < 0
        idx = 5 # 480p

    qualityOrder = qualities.slice(idx).concat(qualities.slice(0, idx).reverse())
    qualityOrder.unshift('auto')
    sourceOrder = []
    flvOrder = []
    for quality in qualityOrder
        if quality of sources
            flv = []
            nonflv = []
            sources[quality].forEach((source) ->
                source.quality = quality
                if source.contentType == 'video/flv'
                    flv.push(source)
                else
                    nonflv.push(source)
            )
            sourceOrder = sourceOrder.concat(nonflv)
            flvOrder = flvOrder.concat(flv)

    return sourceOrder.concat(flvOrder).map((source) ->
        type: source.contentType
        src: source.link
        res: source.quality
        label: getSourceLabel(source)
    )

getSourceLabel = (source) ->
    if source.res is 'auto'
        return 'auto'
    else
        return "#{source.quality}p #{source.contentType.split('/')[1]}"

hasAnyTextTracks = (data) ->
    ntracks = data?.meta?.textTracks?.length ? 0
    return ntracks > 0

hasAnyAudioTracks = (data) ->
    ntracks = data?.meta?.audioTracks?.length ? 0
    return ntracks > 0

isAdaptiveMediaType = (type) ->
    String(type ? '').split(';')[0].trim().toLowerCase() in [
        'application/dash+xml', 'application/x-mpegurl',
        'application/vnd.apple.mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'
    ]

registerNativeFileSourceHandler = ->
    html5 = videojs.getTech('Html5')
    return if html5.syncFileSourceHandler
    # canPlayType() can reject a MIME hint even when the URL plays directly.
    # Append a native fallback after the existing HLS/DASH/native handlers.
    html5.syncFileSourceHandler =
        canPlayType: (type) ->
            if isAdaptiveMediaType(type) then '' else 'maybe'
        canHandleSource: (source) ->
            if isAdaptiveMediaType(source.type) then '' else 'maybe'
        handleSource: html5.nativeSourceHandler.handleSource
        dispose: ->
    html5.registerSourceHandler(html5.syncFileSourceHandler)

window.VideoJSPlayer = class VideoJSPlayer extends Player
    constructor: (data) ->
        if not (this instanceof VideoJSPlayer)
            return new VideoJSPlayer(data)

        @load(data)

    loadPlayer: (data) ->
        loadToken = @loadToken
        waitUntilDefined(window, 'videojs', =>
            return unless loadToken is @loadToken
            registerNativeFileSourceHandler()
            attrs =
                width: '100%'
                height: '100%'

            if @mediaType == 'cm' and hasAnyTextTracks(data)
                attrs.crossorigin = 'anonymous'

            video = $('<video/>')
                .addClass('video-js vjs-default-skin embed-responsive-item')
                .attr(attrs)
            removeOld(video)

            @sources = sortSources(data.meta.direct)
            if @sources.length == 0
                console.error('VideoJSPlayer::constructor(): data.meta.direct
                               has no sources!')
                @mediaType = null
                return

            @sourceIdx = 0

            # TODO: Refactor VideoJSPlayer to use a preLoad()/load()/postLoad() pattern
            # VideoJSPlayer should provide the core functionality and logic for specific
            # dependent player types (gdrive) should be an extension
            if data.meta.gdrive_subtitles
                data.meta.gdrive_subtitles.available.forEach((subt) ->
                    label = subt.lang_original
                    if subt.name
                        label += " (#{subt.name})"
                    $('<track/>').attr(
                        src: "/gdvtt/#{data.id}/#{subt.lang}/#{subt.name}.vtt?\
                                vid=#{data.meta.gdrive_subtitles.vid}"
                        kind: 'subtitles'
                        srclang: subt.lang
                        label: label
                    ).appendTo(video)
                )

            if data.meta.textTracks
                data.meta.textTracks.forEach((track) ->
                    label = track.name
                    attrs =
                        src: track.url
                        kind: 'subtitles'
                        type: track.type
                        label: label

                    if track.default? and track.default
                        attrs.default = ''

                    $('<track/>').attr(attrs).appendTo(video)
                )

            pluginData =
                videoJsResolutionSwitcher:
                    default: @sources[0].res

            if hasAnyAudioTracks(data)
                pluginData.audioSwitch =
                    audioTracks: data.meta.audioTracks,
                    volume: VOLUME

            @player = videojs(video[0],
                    # https://github.com/Dash-Industry-Forum/dash.js/issues/2184
                    autoplay: @sources[0].type != 'application/dash+xml',
                    controls: true,
                    plugins: pluginData

            )
            @player.ready(=>
                return unless loadToken is @loadToken
                # Have to use updateSrc instead of <source> tags
                # see: https://github.com/videojs/video.js/issues/3428
                @player.poster(data.meta.thumbnail)
                @player.on('error', =>
                    return unless loadToken is @loadToken
                    err = @player.error()
                    if err and err.code in [2, 3, 4]
                        console.error('Caught error, trying next source')
                        # Does this really need to be done manually?
                        @sourceIdx++
                        if @sourceIdx < @sources.length
                            @player.error(null)
                            @player.src(@sources[@sourceIdx])
                        else
                            @showPlaybackFailure(err.code)
                            if @mediaType is 'gd'
                                if not window.hasDriveUserscript
                                    window.promptToInstallDriveUserscript()
                                else
                                    window.tellUserNotToContactMeAboutThingsThatAreNotSupported()
                )
                @player.on('loadeddata', =>
                    return unless loadToken is @loadToken
                    @playbackFailed = false
                    $('#media-playback-warning').remove()
                    if @latestUpdate and not CLIENT.leader
                        handleMediaUpdate(@latestUpdate)
                )
                @player.updateSrc(@sources)
                @setVolume(VOLUME)
                @player.on('ended', =>
                    if loadToken is @loadToken and CLIENT.leader and not @playbackFailed
                        socket.emit('playNext')
                )

                @player.on('pause', =>
                    @paused = true
                    if loadToken is @loadToken and CLIENT.leader and not @playbackFailed
                        sendVideoUpdate()
                )

                @player.on('play', =>
                    @paused = false
                    if loadToken is @loadToken and CLIENT.leader and not @playbackFailed
                        sendVideoUpdate()
                )

                # Workaround for IE-- even after seeking completes, the loading
                # spinner remains.
                @player.on('seeked', =>
                    $('.vjs-waiting').removeClass('vjs-waiting')
                )

                # Workaround for Chrome-- it seems that the click bindings for
                # the subtitle menu aren't quite set up until after the ready
                # event finishes, so set a timeout for 1ms to force this code
                # not to run until the ready() function returns.
                setTimeout(->
                    $('#ytapiplayer .vjs-subtitles-button .vjs-menu-item').each((i, elem) ->
                        textNode = elem.childNodes[0]
                        if textNode.textContent == localStorage.lastSubtitle
                            elem.click()

                        elem.onclick = ->
                            if elem.attributes['aria-checked'].value == 'true'
                                localStorage.lastSubtitle = textNode.textContent
                    )
                , 1)
            )
        )

    load: (data) ->
        # Note: VideoJS does have facilities for loading new videos into the
        # existing player object, however it appears to be pretty glitchy when
        # a video can't be played (either previous or next video).  It's safer
        # to just reset the entire thing.
        @destroy()
        @loadToken = {}
        @setMediaProperties(data)
        @playlistUid = PL_CURRENT
        @playbackId = data.playbackId
        @playbackFailed = false
        @latestUpdate = data
        @loadPlayer(data)

    reportPlaybackFailure: ->
        socket.emit('mediaPlaybackError',
            uid: @playlistUid
            playbackId: @playbackId
            id: @mediaId
            type: @mediaType
        )

    showPlaybackFailure: (code) ->
        return if @playbackFailed
        @playbackFailed = true
        @player.pause()
        message = switch code
            when 2 then 'The media could not be downloaded. The server or network may be unavailable.'
            when 3 then 'Your browser could not decode this media. The codec may be unsupported or the file may be damaged.'
            else 'Your browser could not load this media. The format may be unsupported, or the host may have blocked the request.'
        message += ' Playback sync is paused for this video. You will automatically rejoin on the next video. Other viewers can keep watching.'
        $('#media-playback-warning').remove()
        makeAlert('Playback unavailable', message, 'alert-warning', true)
            .attr('id', 'media-playback-warning')
            .insertAfter($('#videowrap-header'))
        @reportPlaybackFailure()

    play: ->
        @paused = false
        if @player and @player.readyState() > 0
            @player.play()

    pause: ->
        @paused = true
        if @player and @player.readyState() > 0
            @player.pause()

    seekTo: (time) ->
        if @player and @player.readyState() > 0
            @player.currentTime(time)

    setVolume: (volume) ->
        if @player
            @player.volume(volume)

    getTime: (cb) ->
        if @player and @player.readyState() > 0
            cb(@player.currentTime())
        else
            cb(0)

    getVolume: (cb) ->
        if @player and @player.readyState() > 0
            if @player.muted()
                cb(0)
            else
                cb(@player.volume())
        else
            cb(VOLUME)

    destroy: ->
        @loadToken = null
        $('#media-playback-warning').remove()
        removeOld()
        if @player
            player = @player
            @player = null
            player.dispose()
