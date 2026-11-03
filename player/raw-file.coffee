codecToMimeType = (codec) ->
    # Compatibility with saved raw entries that predate explicit MIME metadata.
    [container, encoding] = String(codec ? '').split('/')
    switch container
        when 'mov' then 'video/mp4'
        when 'flv' then 'video/x-flv'
        when 'matroska'
            if encoding in ['vp8', 'vp9', 'av1'] then 'video/webm' else 'video/x-matroska'
        when 'ogg' then 'video/ogg'
        when 'mp3' then 'audio/mpeg'
        when 'vorbis', 'opus' then 'audio/ogg'
        when 'aac' then 'audio/aac'
        else 'application/octet-stream'

window.FilePlayer = class FilePlayer extends VideoJSPlayer
    constructor: (data) ->
        if not (this instanceof FilePlayer)
            return new FilePlayer(data)

        data.meta.direct ?=
            480: [{
                contentType: codecToMimeType(data.meta.codec)
                link: data.id
            }]
        super(data)

    load: (data) ->
        data.meta.direct ?=
            480: [{
                contentType: codecToMimeType(data.meta.codec)
                link: data.id
            }]
        super(data)
