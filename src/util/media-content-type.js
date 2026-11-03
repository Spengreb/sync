// These are MIME hints, not a list of permitted formats. Unknown formats are
// still passed to the browser, which can inspect the original media response.
const TYPES = Object.assign(Object.create(null), {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    mkv: 'video/x-matroska', matroska: 'video/x-matroska', webm: 'video/webm',
    ogv: 'video/ogg', ogg: 'video/ogg', avi: 'video/x-msvideo',
    flv: 'video/x-flv', mpeg: 'video/mpeg', mpegts: 'video/mp2t',
    mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4',
    opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav'
});

export function mediaContentType(container, filename = '', medium = 'video') {
    const aliases = String(container || '').toLowerCase().split(',').map(alias => alias.trim());
    const pathname = String(filename).split(/[?#]/)[0];
    const extension = ((pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
    // ffprobe uses the same list of aliases for MP4/MOV and for WebM/Matroska.
    let format = aliases.includes('mp4') ? 'mp4' : aliases.find(alias => TYPES[alias]);
    if (aliases.includes('matroska') && aliases.includes('webm') && extension === 'webm') {
        format = 'webm';
    }
    if (!format && !aliases.some(Boolean)) format = (extension || '').toLowerCase();
    const type = TYPES[format] || 'application/octet-stream';
    return medium === 'audio' ? type.replace(/^video\//, 'audio/') : type;
}

export function isMediaContentType(value) {
    return typeof value === 'string' &&
        !/[\r\n]/.test(value) &&
        /^(?:audio|video)\/[a-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/i.test(value);
}
