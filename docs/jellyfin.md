# Jellyfin download links

Paste an authenticated Jellyfin download URL directly into the playlist:

```text
https://jellyfin.example.com/Items/0123456789abcdef0123456789abcdef/Download?ApiKey=YOUR_TOKEN
```

The raw-file provider recognizes the download path, fetches the item's title,
duration and container through Jellyfin's API, and sends it to the existing
Video.js player as custom media. It does not send HEAD requests or run ffprobe
against the download. No hosted JSON manifest or new player is required.
Saved entries use the custom-media provider and can be queued again normally.
Explicit `fi:` and `cm:` prefixes also work.

Jellyfin base paths (for example `/jellyfin/Items/.../Download`) are supported.
The authentication query parameter can be `ApiKey`, `api_key` or `access_token`.
The original download URL is used unchanged for browser playback, so it must
already work with your Jellyfin version's authentication settings.

Requirements:

- A valid HTTPS certificate and a server reachable by Sync and every viewer.
- A token allowed to read metadata and download the item.
- An original MP4, WebM or Ogg video with codecs supported by viewers' browsers.
  Download URLs serve the original file; they do not negotiate transcoding.
- The channel's existing permission to add raw video files.

This handles authenticated file downloads. Jellyfin web-page URLs, transcoding
sessions, library browsing, login and automatic subtitle extraction are not
included. Playback controls and synchronization use the existing room behavior.

The token remains in the shared playback URL and saved playlist/library entries,
just as with a custom-media manifest. Anyone who can read those entries can use
it. Jellyfin server API keys can grant broad server access; use a credential
appropriate for sharing. The metadata request uses an authorization header and
the media lookup log omits the download's query string.
