const assert = require('assert');
const ffmpeg = require('../lib/ffmpeg');
const Config = require('../lib/config');
const https = require('https');
const { EventEmitter } = require('events');
const sinon = require('sinon');

describe('ffmpeg', () => {
    describe('#query', () => {
        let sandbox, metadata, enabled, contentType;

        beforeEach(() => {
            sandbox = sinon.createSandbox();
            enabled = Config.get('ffmpeg.enabled');
            Config.set('ffmpeg.enabled', true);
            contentType = 'video/mp4';
            metadata = {
                format: {
                    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
                    duration: '10.000000',
                    tags: {}
                },
                streams: [
                    { codec_type: 'video', codec_name: 'vp9' },
                    { codec_type: 'audio', codec_name: 'aac' }
                ]
            };
            sandbox.stub(https, 'request').callsFake((_options, callback) => {
                const req = new EventEmitter();
                req.abort = () => {};
                req.end = () => process.nextTick(() => callback({
                    statusCode: 200,
                    headers: { 'content-type': contentType }
                }));
                return req;
            });
            sandbox.stub(ffmpeg, 'ffprobe').callsFake((_filename, callback) => {
                process.nextTick(() => callback(null, metadata));
            });
        });

        afterEach(() => {
            sandbox.restore();
            Config.set('ffmpeg.enabled', enabled);
        });

        function query(url) {
            return new Promise((resolve, reject) => {
                ffmpeg.query(url, (error, data) => error ? reject(new Error(error)) : resolve(data));
            });
        }

        it('rejects plain http links', done => {
            ffmpeg.query('http://foo.bar/baz.mp4', err => {
                assert(/begins with 'https:/.test(err),
                        `Expected error due to plain HTTP but got "${err}"`);
                done();
            });
        });

        it('accepts VP9 video and AAC audio in an MP4 container', async () => {
            const media = await query('https://samplelib.com/mp4/sample-10s-vp9.mp4');
            assert.strictEqual(media.codec, 'mov/vp9');
            assert.strictEqual(media.duration, 10);
            assert.strictEqual(media.title, 'sample-10s-vp9.mp4');
            assert.strictEqual(media.contentType, 'video/mp4');
        });

        it('accepts HEVC in MKV served as a generic download', async () => {
            contentType = 'application/octet-stream';
            metadata.format.format_name = 'matroska,webm';
            metadata.streams[0].codec_name = 'hevc';
            const media = await query('https://example.com/movie.mkv');
            assert.strictEqual(media.codec, 'matroska/hevc');
            assert.strictEqual(media.contentType, 'video/x-matroska');
        });

        it('passes unfamiliar video codecs and containers to the browser', async () => {
            contentType = undefined;
            metadata.format.format_name = 'future-container';
            metadata.streams[0].codec_name = 'future-codec';
            const media = await query('https://example.com/movie.future');
            assert.strictEqual(media.codec, 'future-container/future-codec');
            assert.strictEqual(media.contentType, 'application/octet-stream');
        });

        it('passes unfamiliar audio codecs to the browser and ignores embedded artwork', async () => {
            contentType = 'application/octet-stream';
            metadata.format.format_name = 'flac';
            metadata.streams = [
                { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
                { codec_type: 'audio', codec_name: 'flac' }
            ];
            const media = await query('https://example.com/song.flac');
            assert.strictEqual(media.codec, 'flac');
            assert.strictEqual(media.contentType, 'audio/flac');
        });

        it('distinguishes WebM from MKV when ffprobe reports both container aliases', async () => {
            contentType = 'application/octet-stream';
            metadata.format.format_name = 'matroska,webm';
            assert.strictEqual((await query('https://example.com/movie.WEBM')).contentType, 'video/webm');
            assert.strictEqual((await query('https://example.com/movie.mkv')).contentType, 'video/x-matroska');
        });

        it('still rejects files with no audio or video streams', async () => {
            metadata.streams = [{ codec_type: 'subtitle', codec_name: 'subrip' }];
            await assert.rejects(query('https://example.com/subtitles.srt'), /did not contain an audio or video stream/);
        });

        it('prefers an embedded title to the filename', async () => {
            metadata.format.tags.title = 'Embedded title';
            assert.strictEqual((await query('https://example.com/movie.mp4')).title, 'Embedded title');
        });

        it('decodes filename titles without including query strings or fragments', async () => {
            metadata.format.tags.title = '   ';
            const media = await query('https://example.com/My%20Movie.mp4?token=private#fragment');
            assert.strictEqual(media.title, 'My Movie.mp4');
        });

        it('handles malformed URL escapes in a filename', async () => {
            assert.strictEqual((await query('https://example.com/movie%ZZ.mp4')).title, 'movie%ZZ.mp4');
        });

        it('keeps the generic fallback for URLs without a filename', async () => {
            assert.strictEqual((await query('https://example.com/')).title, 'Raw Video');
        });

        it('uses filename titles for audio-only files too', async () => {
            metadata.format.format_name = 'mp3';
            metadata.streams = [{ codec_type: 'audio', codec_name: 'mp3' }];
            const media = await query('https://example.com/My%20Song.mp3?token=private');
            assert.strictEqual(media.title, 'My Song.mp3');
            assert.strictEqual(media.codec, 'mp3');
        });
    });
});
