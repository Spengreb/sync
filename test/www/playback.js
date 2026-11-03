const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const coffee = require('coffeescript');
const sinon = require('sinon');
const { EventEmitter } = require('events');

describe('browser media playback', () => {
    let context, html5, players, ready, warnings, emitted;

    function sourceData(id = 'https://example.com/movie.mkv', type = 'video/x-matroska') {
        return {
            id, type: 'cm', seconds: 60, currentTime: 15, playbackId: 1,
            meta: { direct: { auto: [{ link: id, contentType: type }] } }
        };
    }

    function flushReady() {
        while (ready.length) ready.shift()();
    }

    beforeEach(() => {
        players = [];
        ready = [];
        warnings = [];
        emitted = [];
        html5 = {
            sourceHandlers: [],
            nativeSourceHandler: { handleSource: (source, tech) => tech.setSrc(source.src) },
            registerSourceHandler(handler) { this.sourceHandlers.push(handler); }
        };
        function jquery() {
            const node = { 0: {}, length: 1, hasClass: () => false };
            for (const name of ['addClass', 'attr', 'appendTo', 'insertAfter', 'insertBefore', 'remove', 'each', 'text']) {
                node[name] = () => node;
            }
            return node;
        }
        jquery.getJSON = () => ({ done() { return this; }, fail() { return this; } });
        function videojs(_element, options) {
            const player = new EventEmitter();
            player.options_ = { sources: [] };
            player.ready = fn => ready.push(fn);
            player.volume = () => 0.5;
            player.poster = () => {};
            player.readyState = () => 4;
            player.paused = () => false;
            player.muted = () => false;
            player.currentTime = sinon.stub().returns(0);
            player.play = sinon.spy();
            player.pause = () => player.emit('pause');
            player.dispose = () => {};
            player.src = sinon.spy();
            player.trigger = event => player.emit(event);
            player.canPlayType = type => html5.sourceHandlers.reduce((result, handler) =>
                result || handler.canPlayType(type), '');
            player.error = function(value) {
                if (arguments.length) {
                    player.mediaError = value;
                    if (value) player.emit('error');
                }
                return player.mediaError;
            };
            videojs.plugins.videoJsResolutionSwitcher.call(player, Object.assign({},
                options.plugins.videoJsResolutionSwitcher, { ui: false }));
            players.push(player);
            return player;
        }
        videojs.getTech = () => html5;
        videojs.plugins = {};
        videojs.registerPlugin = (name, plugin) => { videojs.plugins[name] = plugin; };
        videojs.getComponent = () => {
            function Component() {}
            Component.registerComponent = () => {};
            return Component;
        };
        videojs.mergeOptions = (...options) => Object.assign({}, ...options);
        videojs.extend = Parent => {
            function Component() {}
            Component.prototype = Object.create(Parent.prototype);
            Component.registerComponent = () => {};
            return Component;
        };
        context = vm.createContext({
            console: { error() {} }, setTimeout() {}, localStorage: { getItem: () => null },
            $: jquery, videojs,
            PL_CURRENT: 12, VOLUME: 0.5,
            USEROPTS: { default_quality: 'best', synch: true, sync_accuracy: 2 },
            CLIENT: { leader: false },
            CHANNEL: { name: 'test', opts: { allow_voteskip: false } },
            setOpt() {},
            waitUntilDefined: (_object, _key, callback) => callback(),
            sendVideoUpdate: sinon.spy(),
            socket: { emit: (...args) => emitted.push(args) },
            makeAlert: (_title, text) => { warnings.push(text); return jquery(); }
        });
        context.window = context;
        vm.runInContext(fs.readFileSync(path.join(__dirname,
            '../../www/js/vjs/videojs-resolution-switcher.js'), 'utf8'), context);
        // The other providers only need names for update.coffee's type map.
        for (const name of ['YouTubePlayer', 'VimeoPlayer', 'DailymotionPlayer', 'GoogleDrivePlayer',
            'SoundCloudPlayer', 'LivestreamPlayer', 'TwitchPlayer', 'CustomEmbedPlayer', 'RTMPPlayer',
            'HLSPlayer', 'StreamablePlayer', 'TwitchClipPlayer', 'PeerPlayer', 'IframeChild',
            'OdyseePlayer', 'WhepPlayer', 'NicoPlayer']) context[name] = function() {};
        const files = ['base.coffee', 'videojs.coffee', 'raw-file.coffee', 'update.coffee'];
        const source = files.map(file => fs.readFileSync(path.join(__dirname, '../../player', file), 'utf8')).join('\n');
        vm.runInContext(coffee.compile(source), context);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../www/js/callbacks.js'), 'utf8'), context);
    });

    function load(data = sourceData()) {
        context.PLAYER = new context.VideoJSPlayer(data);
        flushReady();
        return context.PLAYER;
    }

    it('attempts unfamiliar progressive MIME types through the native source handler', () => {
        load();
        const fallback = html5.sourceHandlers[0];
        for (const type of ['video/x-matroska', 'video/future', 'audio/flac', 'application/octet-stream']) {
            assert.strictEqual(fallback.canPlayType(type), 'maybe');
            assert.strictEqual(fallback.canHandleSource({ type }), 'maybe');
        }
        const tech = { setSrc: sinon.spy() };
        fallback.handleSource({ src: 'https://example.com/movie.mkv' }, tech);
        sinon.assert.calledWith(tech.setSrc, 'https://example.com/movie.mkv');
        load();
        assert.strictEqual(html5.sourceHandlers.length, 1);
    });

    it('leaves adaptive manifests to their existing source handlers', () => {
        load();
        for (const type of ['application/dash+xml', 'application/x-mpegURL', 'application/vnd.apple.mpegurl']) {
            assert.strictEqual(html5.sourceHandlers[0].canPlayType(type), '');
            assert.strictEqual(html5.sourceHandlers[0].canHandleSource({ type }), '');
        }
    });

    it('shows a playback warning instead of crashing when no adaptive handler is available', () => {
        const player = load(sourceData('https://example.com/stream.mpd', 'application/dash+xml'));
        assert.strictEqual(player.playbackFailed, true);
        assert.strictEqual(warnings.length, 1);
    });

    it('warns only this viewer and suppresses repeated sync attempts after a terminal failure', () => {
        const player = load();
        players[0].error({ code: 4 });
        assert.strictEqual(player.playbackFailed, true);
        assert.strictEqual(warnings.length, 1);
        assert(warnings[0].includes('host may have blocked'));
        assert(warnings[0].includes('automatically rejoin'));
        assert.strictEqual(emitted[0][0], 'mediaPlaybackError');
        assert.strictEqual(emitted[0][1].uid, 12);
        assert.strictEqual(emitted[0][1].playbackId, 1);
        context.handleMediaUpdate({ currentTime: 30, paused: false });
        assert.strictEqual(player.latestUpdate.currentTime, 30);
        sinon.assert.notCalled(players[0].play);
        sinon.assert.notCalled(players[0].currentTime);
        players[0].error({ code: 4 });
        assert.strictEqual(warnings.length, 1);
    });

    it('tries another source before excluding the viewer', () => {
        const data = sourceData();
        data.meta.direct.auto.push({ link: 'https://example.com/movie.mp4', contentType: 'video/mp4' });
        const player = load(data);
        players[0].error({ code: 3 });
        assert.strictEqual(player.playbackFailed, false);
        assert.strictEqual(players[0].src.lastCall.args[0].src, 'https://example.com/movie.mp4');
        assert.strictEqual(warnings.length, 0);
        players[0].error({ code: 2 });
        assert.strictEqual(player.playbackFailed, true);
        assert(warnings[0].includes('server or network'));
    });

    it('automatically resumes sync when the next video loads', () => {
        const player = load();
        const old = players[0];
        old.error({ code: 3 });
        context.handleMediaUpdate(sourceData('https://example.com/next.mp4', 'video/mp4'));
        flushReady();
        assert.strictEqual(player.playbackFailed, false);
        assert.strictEqual(player.mediaId, 'https://example.com/next.mp4');
        players[1].emit('loadeddata');
        sinon.assert.calledWith(players[1].currentTime, 15);
        old.error({ code: 4 });
        assert.strictEqual(player.playbackFailed, false);
        assert.strictEqual(warnings.length, 1);
    });

    it('retries the same URL when a new playlist playback starts', () => {
        const player = load();
        players[0].error({ code: 4 });
        const data = sourceData();
        data.playbackId = 2;
        context.Callbacks.changeMedia(data);
        flushReady();
        assert.strictEqual(player.playbackFailed, false);
        assert.strictEqual(player.playbackId, 2);
        assert.strictEqual(players.length, 2);
    });

    it('does not let a failed playback leader publish pause/play/ended events', () => {
        context.CLIENT.leader = true;
        load();
        players[0].error({ code: 4 });
        players[0].emit('pause');
        players[0].emit('play');
        players[0].emit('ended');
        sinon.assert.notCalled(context.sendVideoUpdate);
        assert.strictEqual(emitted.length, 1);
    });

    it('preserves the explicit MIME type of raw files instead of guessing from the codec', () => {
        const data = sourceData();
        data.type = 'fi';
        data.meta.codec = 'matroska/vp9';
        const player = new context.FilePlayer(data);
        flushReady();
        assert.strictEqual(player.sources[0].type, 'video/x-matroska');
    });
});
