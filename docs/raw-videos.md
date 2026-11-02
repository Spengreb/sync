# Raw Videos / Audio #

Want to host your own video/audio files for use on CyTube?  For servers with the
ffprobe module enabled, CyTube supports this!  However, in order to provide a
consistent experience, there are limitations.

## Hosting the File ##

CyTube requires a direct link to the file in order to query it for metadata such
as duration and encoding.  The website where you host the file needs to be able
to serve the video directly (rather than embedding it in a flash
player/iframe/etc.).  It also needs to serve the correct MIME type for the video
in the `Content-Type` HTTP header, e.g. `video/mp4`.

I don't recommend hosting videos on Dropbox-type services, as they aren't built
to distribute video to many users at a time and often have strict bandwidth
limits.  File hosting sites such as Putlocker also cause problems due to being
unable to serve the file directly, or due to binding the link to the IP address
of the user who retrieved it.  For best results when using raw video, host the
video yourself on a VPS or dedicated server with plenty of bandwidth.

Note that CyTube only queries the file for metadata, it does not proxy it for
users!  Every user watching the video will be downloading it individually.

Playlist titles use the file's embedded title when available, otherwise the
filename from the URL. Query parameters are not included in the title.

## Encoding the Video ##

Sync accepts any audio/video format that its ffprobe installation can identify.
There is no server codec allowlist. This includes MKV, HEVC and VP9 in MP4;
accepting a file does not guarantee that every viewer's browser can play it.
Downloads served as `application/octet-stream` are also probed normally.

Each browser attempts the original file. If all available sources fail, that
viewer sees a warning and playback sync is suspended for that video. Chat and
room updates continue, and the next playlist item gets a fresh playback attempt.
If the assigned playback leader fails, the server runs the timeline for that
item and restores the assigned leader on the next video.

Loading failures can also come from networking, authentication or hotlink
blocking; a failure is not automatically proof of an unsupported codec. Sync
does not transcode files. For broad compatibility, MP4 with H.264 video and AAC
audio remains a useful choice. If preparing MP4 files, use the
[faststart](https://trac.ffmpeg.org/wiki/Encode/H.264#faststartforwebvideo)
flag.

### Subtitles ###

Unfortunately, soft-subtitles are not supported right now.  This is something
that may be supported in the future, but currently if you need subtitles, they
will have to be hardsubbed onto the video itself.
