const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const sinon = require('sinon');
const { lookup, parseDownloadURL } = require('../lib/jellyfin');
const info = require('../lib/get-info');
const ffmpeg = require('../lib/ffmpeg');
const customMedia = require('../lib/custom-media');

describe('Jellyfin download links', () => {
    const itemId = '0123456789abcdef0123456789abcdef';
    const downloadURL = `https://media.example.com/jellyfin/Items/${itemId}/Download?ApiKey=test-token`;
    let item, get, sandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        item = {
            Id: itemId,
            Name: 'Test episode',
            RunTimeTicks: 13248200000,
            Container: 'mp4',
            MediaSources: [{ Id: itemId, Container: 'mp4' }]
        };
        get = sandbox.stub(https, 'get');
        respond(() => JSON.stringify({ Items: [item] }));
    });

    afterEach(() => sandbox.restore());

    function respond(body, status = 200) {
        get.callsFake((_url, _options, callback) => {
            const req = new EventEmitter();
            const res = new PassThrough();
            res.statusCode = status;
            req.destroy = () => {
                res.destroy();
                req.emit('close');
            };
            res.on('close', () => req.emit('close'));
            process.nextTick(() => {
                callback(res);
                if (!res.destroyed) res.end(body());
            });
            return req;
        });
    }

    function getMedia(url, type) {
        return new Promise((resolve, reject) => {
            info.getMedia(url, type, (error, media) => {
                if (error) reject(new Error(error));
                else resolve(media);
            });
        });
    }

    it('retrieves metadata with GET and converts ticks to the room duration', async () => {
        const media = await lookup(downloadURL);
        assert.strictEqual(media.type, 'cm');
        assert.strictEqual(media.id, downloadURL);
        assert.strictEqual(media.title, 'Test episode');
        assert.strictEqual(media.seconds, 1324);
        assert.strictEqual(media.duration, '22:04');
        assert.deepStrictEqual(media.pack().meta.direct, {
            auto: [{ link: downloadURL, contentType: 'video/mp4' }]
        });

        const [url, options] = get.firstCall.args;
        assert.strictEqual(url.origin, 'https://media.example.com');
        assert.strictEqual(url.pathname, '/jellyfin/Items');
        assert.strictEqual(url.searchParams.get('Ids'), itemId);
        assert.strictEqual(url.searchParams.get('Fields'), 'MediaSources,MediaStreams,Path');
        assert(!url.href.includes('test-token'));
        assert.strictEqual(options.headers.Authorization, 'MediaBrowser Token="test-token"');
    });

    it('queues raw URLs without HEAD or ffprobe and reloads saved custom-media entries', async () => {
        const probe = sandbox.stub(ffmpeg, 'query');
        const manifest = sandbox.stub(customMedia, 'lookup');
        const queued = await getMedia(downloadURL, 'fi');
        const saved = queued.pack();
        const reloaded = await getMedia(saved.id, saved.type);
        assert.deepStrictEqual(reloaded.pack(), saved);
        assert.strictEqual(get.callCount, 2);
        sinon.assert.notCalled(probe);
        sinon.assert.notCalled(manifest);
    });

    it('keeps ordinary raw-file and JSON-manifest lookups unchanged', async () => {
        const probe = sandbox.stub(ffmpeg, 'query').callsFake((_id, cb) => cb(null, {
            title: 'Raw file', duration: 10, codec: 'mov/h264'
        }));
        const manifest = sandbox.stub(customMedia, 'lookup').resolves('manifest result');
        const raw = await getMedia('https://example.com/file.mp4', 'fi');
        assert.strictEqual(raw.type, 'fi');
        assert.strictEqual(await getMedia('https://example.com/test.json', 'cm'), 'manifest result');
        sinon.assert.calledOnce(probe);
        sinon.assert.calledOnce(manifest);
        sinon.assert.notCalled(get);
    });

    it('supports a root URL, dashed item IDs and alternative token spellings', async () => {
        const dashed = '01234567-89ab-cdef-0123-456789abcdef';
        for (const key of ['api_key', 'apikey', 'access_token']) {
            const url = `https://media.example.com/Items/${dashed}/Download?${key}=test-token`;
            assert.strictEqual((await lookup(url)).id, url);
            assert.strictEqual(parseDownloadURL(url).basePath, '');
        }
    });

    it('keeps metadata requests on the download host even for a double-slash base path', async () => {
        const url = `https://media.example.com//other.example/Items/${itemId}/Download?ApiKey=test-token`;
        await lookup(url);
        assert.strictEqual(get.firstCall.args[0].origin, 'https://media.example.com');
        assert.strictEqual(get.firstCall.args[0].pathname, '//other.example/Items');
    });

    it('reports interrupted responses rather than leaving a lookup pending', async () => {
        get.callsFake((_url, _options, callback) => {
            const req = new EventEmitter();
            process.nextTick(() => {
                const res = new PassThrough();
                res.statusCode = 200;
                callback(res);
                res.emit('aborted');
                res.destroy();
                req.emit('close');
            });
            return req;
        });
        await assert.rejects(lookup(downloadURL), /response was interrupted/);
    });

    it('does not treat other URLs as Jellyfin downloads', () => {
        for (const url of [
            'not a URL', 'https://example.com/movie.mp4',
            `https://example.com/Items/${itemId}`, 'https://example.com/Items/not-an-id/Download'
        ]) {
            assert.strictEqual(parseDownloadURL(url), null);
        }
    });

    it('rejects insecure URLs and missing or unsafe credentials before making a request', async () => {
        await assert.rejects(lookup(downloadURL.replace('https:', 'http:')), /must use HTTPS/);
        await assert.rejects(lookup(downloadURL.split('?')[0]), /must include a valid/);
        await assert.rejects(lookup(downloadURL.replace('test-token', 'bad%22token')), /must include a valid/);
        await assert.rejects(lookup(downloadURL.replace('https://', 'https://user:password@')), /URL login credentials/);
        sinon.assert.notCalled(get);
    });

    it('reads container metadata for the original source, not an alternate version', async () => {
        delete item.Container;
        item.MediaSources.unshift({ Id: 'a'.repeat(32), Container: 'mkv' });
        assert.strictEqual((await lookup(downloadURL)).meta.direct.auto[0].contentType, 'video/mp4');
        item.MediaSources[1].Container = 'webm';
        assert.strictEqual((await lookup(downloadURL)).meta.direct.auto[0].contentType, 'video/webm');
    });

    it('accepts a single source whose ID differs from the item ID', async () => {
        delete item.Container;
        item.MediaSources[0].Id = 'b'.repeat(32);
        assert.strictEqual((await lookup(downloadURL)).meta.direct.auto[0].contentType, 'video/mp4');
    });

    it('matches the original file path when there are multiple unrelated source IDs', async () => {
        delete item.Container;
        item.Path = '/library/episode.mp4';
        item.MediaSources = [
            { Id: 'a'.repeat(32), Path: '/library/alternate.mkv', Container: 'mkv' },
            { Id: 'b'.repeat(32), Path: item.Path, Container: 'mp4' }
        ];
        assert.strictEqual((await lookup(downloadURL)).meta.direct.auto[0].contentType, 'video/mp4');
    });

    it('normalizes container aliases and falls back to the original file extension', async () => {
        item.Container = ' mov,mp4,m4a,3gp,3g2,mj2 ';
        assert.strictEqual((await lookup(downloadURL)).meta.direct.auto[0].contentType, 'video/mp4');
        delete item.Container;
        item.MediaSources = [];
        item.Path = '/library/episode.MP4';
        assert.strictEqual((await lookup(downloadURL)).meta.direct.auto[0].contentType, 'video/mp4');
    });

    it('distinguishes missing format metadata from an unsupported format', async () => {
        delete item.Container;
        item.MediaSources = [];
        await assert.rejects(lookup(downloadURL), /did not provide the original file format/);
        item.Container = 'mkv';
        item.Path = '/library/misleading.mp4';
        await assert.rejects(lookup(downloadURL), /unsupported video format \(mkv\)/);
    });

    it('does not infer the original format from an unrelated alternate source', async () => {
        delete item.Container;
        item.MediaSources = [
            { Id: 'a'.repeat(32), Container: 'mp4' },
            { Id: 'b'.repeat(32), Container: 'mp4' }
        ];
        await assert.rejects(lookup(downloadURL), /did not provide the original file format/);
    });

    it('rejects missing or invalid metadata and unsupported original formats', async () => {
        respond(() => JSON.stringify({ Items: [] }));
        await assert.rejects(lookup(downloadURL), /not found or is not accessible/);
        respond(() => JSON.stringify({ Items: [item] }));
        item.RunTimeTicks = null;
        await assert.rejects(lookup(downloadURL), /valid video duration/);
        item.RunTimeTicks = 13248200000;
        item.Container = 'mkv';
        await assert.rejects(lookup(downloadURL), /download links do not transcode/);
    });

    it('reports authorization failures without echoing the token or response body', async () => {
        respond(() => 'secret response: test-token', 403);
        await assert.rejects(lookup(downloadURL), error =>
            /denied access/.test(error.message) && !error.message.includes('test-token'));
    });

    it('rejects redirects without forwarding credentials', async () => {
        respond(() => '', 302);
        await assert.rejects(lookup(downloadURL), /HTTP 302/);
        sinon.assert.calledOnce(get);
    });

    it('rejects malformed and oversized responses', async () => {
        respond(() => 'invalid JSON');
        await assert.rejects(lookup(downloadURL), /invalid JSON metadata/);
        respond(() => 'x'.repeat(1024 * 1024 + 1));
        await assert.rejects(lookup(downloadURL), /response is too large/);
    });

    it('bounds a request that never responds', async () => {
        const clock = sandbox.useFakeTimers();
        const req = new EventEmitter();
        req.destroy = sandbox.spy(() => req.emit('close'));
        get.returns(req);
        const pending = assert.rejects(lookup(downloadURL), /timed out/);
        await clock.tickAsync(10000);
        await pending;
        sinon.assert.calledOnce(req.destroy);
    });
});
