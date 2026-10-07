import https from 'https';
import { URL } from 'url';
import Media from './media';

const DOWNLOAD_PATH = /^(.*)\/Items\/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/Download\/?$/i;
const MAX_METADATA_BYTES = 1024 * 1024;
const METADATA_TIMEOUT = 10000;

// Jellyfin can be hosted at any domain, with an optional reverse-proxy base path.
export function parseDownloadURL(value) {
    try {
        const url = new URL(value);
        const match = url.pathname.match(DOWNLOAD_PATH);
        if (!match) return null;

        let token;
        for (const [key, val] of url.searchParams) {
            if (/^(api_?key|access_token)$/i.test(key)) token = val;
        }

        return { url, basePath: match[1], itemId: match[2], token };
    } catch (_error) {
        return null;
    }
}

function getMetadata(url, token) {
    return new Promise((resolve, reject) => {
        // Do not follow redirects: the authentication token belongs to this host.
        const req = https.get(url, {
            headers: {
                Accept: 'application/json',
                Authorization: `MediaBrowser Token="${token}"`
            }
        }, res => {
            res.on('error', () => reject(new Error('Unable to read Jellyfin metadata.')));
            res.on('aborted', () => reject(new Error('Jellyfin metadata response was interrupted.')));
            if (res.statusCode !== 200) {
                res.destroy();
                if (res.statusCode === 401 || res.statusCode === 403) {
                    reject(new Error('Jellyfin denied access. Check the API key and item permissions.'));
                } else {
                    reject(new Error(`Jellyfin metadata request failed (HTTP ${res.statusCode}).`));
                }
                return;
            }

            let bytes = 0;
            const chunks = [];
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_METADATA_BYTES) {
                    reject(new Error('Jellyfin metadata response is too large.'));
                    res.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch (_error) {
                    reject(new Error('Jellyfin returned invalid JSON metadata.'));
                }
            });
        });

        // Bound the whole request, including responses that trickle in indefinitely.
        const timer = setTimeout(() => {
            reject(new Error('Jellyfin metadata request timed out.'));
            req.destroy();
        }, METADATA_TIMEOUT);
        req.on('close', () => clearTimeout(timer));
        req.on('error', () => {
            clearTimeout(timer);
            // Network errors can contain authenticated URLs; do not echo them.
            reject(new Error('Unable to reach Jellyfin for metadata. Check the server address and HTTPS certificate.'));
        });
    });
}

export async function lookup(value) {
    const download = parseDownloadURL(value);
    if (!download) throw new Error('Invalid Jellyfin download URL.');
    const { url, basePath, itemId, token } = download;
    if (url.protocol !== 'https:') {
        throw new Error('Jellyfin download links must use HTTPS.');
    }
    if (url.username || url.password) {
        throw new Error('Use an API key in the Jellyfin download URL instead of URL login credentials.');
    }
    if (!token || !/^[a-z0-9._~-]+$/i.test(token)) {
        throw new Error('Jellyfin download links must include a valid ApiKey, api_key or access_token.');
    }

    // /Items/{id} needs a user context on some Jellyfin versions. The filtered
    // collection endpoint also works with server API keys without a user ID.
    const metadataURL = new URL(url.origin);
    metadataURL.pathname = `${basePath}/Items`;
    metadataURL.searchParams.set('Ids', itemId);
    metadataURL.searchParams.set('Fields', 'MediaSources,MediaStreams');
    metadataURL.searchParams.set('EnableImages', 'false');
    const result = await getMetadata(metadataURL, token);
    const item = result && Array.isArray(result.Items) && result.Items.find(entry =>
        entry && typeof entry.Id === 'string' &&
        entry.Id.replace(/-/g, '').toLowerCase() === itemId.replace(/-/g, '').toLowerCase());
    if (!item) throw new Error('Jellyfin item was not found or is not accessible with this API key.');

    const seconds = item.RunTimeTicks / 10000000;
    if (typeof item.RunTimeTicks !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('Jellyfin did not provide a valid video duration.');
    }
    if (typeof item.Name !== 'string' || !item.Name.trim()) {
        throw new Error('Jellyfin did not provide a video title.');
    }

    // Download serves the original item, not an alternate version or transcode.
    const source = Array.isArray(item.MediaSources) && item.MediaSources.find(entry =>
        entry && typeof entry.Id === 'string' &&
        entry.Id.replace(/-/g, '').toLowerCase() === itemId.replace(/-/g, '').toLowerCase());
    const container = String(item.Container || (source && source.Container) || '').toLowerCase();
    const contentType = {
        mp4: 'video/mp4',
        m4v: 'video/mp4',
        webm: 'video/webm',
        ogv: 'video/ogg',
        ogg: 'video/ogg'
    }[container];
    if (!contentType) {
        throw new Error('This Jellyfin download is not a supported browser video format. Use an MP4, WebM or Ogg video; download links do not transcode.');
    }

    // The same payload as a custom-media manifest, without hosting a JSON file.
    // Preserve the original URL (including its token) for browser playback.
    return new Media(value, item.Name, seconds, 'cm', {
        direct: {
            auto: [{ link: value, contentType }]
        }
    });
}
