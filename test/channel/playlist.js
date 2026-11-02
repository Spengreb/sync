const PlaylistModule = require('../../lib/channel/playlist');
const assert = require('assert');
const Config = require('../../lib/config');
const Media = require('../../lib/media');
const sinon = require('sinon');

describe('PlaylistModule', () => {
    describe('per-viewer playback failure', () => {
        let sandbox, clock, channel, playlist, leader;

        beforeEach(() => {
            sandbox = sinon.createSandbox();
            clock = sandbox.useFakeTimers();
            leader = { getName: () => 'leader' };
            channel = {
                modules: {}, users: [], logger: { log() {} },
                broadcastAll: sandbox.spy(),
                checkModules: (_name, _args, callback) => callback(),
                notifyModules() {}
            };
            playlist = new PlaylistModule(channel);
            playlist.current = {
                uid: 12,
                media: new Media('https://example.com/movie.mkv', 'Movie', 60, 'cm')
            };
            playlist.current.media.currentTime = 15;
            playlist.leader = leader;
        });

        afterEach(() => {
            playlist.unload();
            sandbox.restore();
        });

        function error(overrides = {}) {
            return Object.assign({
                uid: playlist.current.uid, playbackId: playlist._playbackId,
                id: playlist.current.media.id, type: playlist.current.media.type
            }, overrides);
        }

        it('keeps the room timeline running when the assigned leader cannot play the item', () => {
            playlist.handlePlaybackError(leader, error());
            assert.strictEqual(playlist.leader, leader);
            assert.strictEqual(playlist._leaderPlaybackFailed, true);
            sinon.assert.calledWith(channel.broadcastAll, 'setLeader', '');
            clock.tick(2000);
            assert.strictEqual(playlist.current.media.currentTime, 17);
            playlist.handleUpdate(leader, { id: playlist.current.media.id, currentTime: 0, paused: true });
            assert.strictEqual(playlist.current.media.currentTime, 17);
            assert.strictEqual(playlist.current.media.paused, false);
        });

        it('leaves other viewers and the designated leader alone when a follower fails', () => {
            playlist.handlePlaybackError({}, error());
            assert.strictEqual(playlist._leaderPlaybackFailed, false);
            assert.strictEqual(playlist._leadInterval, false);
            sinon.assert.notCalled(channel.broadcastAll);
        });

        it('ignores stale failures, including a repeated URL from an earlier playback', () => {
            for (const overrides of [{ uid: 11 }, { playbackId: -1 }, { id: 'old' }, { type: 'fi' }]) {
                playlist.handlePlaybackError(leader, error(overrides));
            }
            assert.strictEqual(playlist._leaderPlaybackFailed, false);
            sinon.assert.notCalled(channel.broadcastAll);
        });

        it('restores the assigned leader after loading the next item and stops the fallback timer', () => {
            playlist.handlePlaybackError(leader, error());
            const previousError = error();
            channel.broadcastAll.resetHistory();
            playlist.startPlayback();
            assert.strictEqual(playlist._leaderPlaybackFailed, false);
            assert.strictEqual(playlist._leadInterval, false);
            const events = channel.broadcastAll.getCalls().map(call => call.args[0]);
            assert(events.indexOf('changeMedia') < events.indexOf('setLeader'));
            sinon.assert.calledWith(channel.broadcastAll, 'setLeader', 'leader');
            playlist.handlePlaybackError(leader, previousError);
            assert.strictEqual(playlist._leaderPlaybackFailed, false);
            clock.tick(2000);
            assert.strictEqual(playlist.current.media.currentTime, 0);
        });

        it('advances the playlist while the leader is unable to play', () => {
            playlist.handlePlaybackError(leader, error());
            const next = sandbox.stub(playlist, '_playNext');
            clock.tick(47000);
            sinon.assert.calledOnce(next);
        });
    });

    describe('#handleClean', () => {
        let fakeChannel = {
            uniqueName: 'testChannel',
            logger: {
                log() {

                }
            },
            broadcastToRoom() {
            },
            broadcastAll() {
            },
            modules: {
                permissions: {
                    canDeleteVideo() {
                        return true;
                    }
                }
            }
        };
        let fakeUser = {
            getName() {
                return 'testUser';
            },
            socket: {
                emit() {
                }
            }
        };
        let playlistModule = new PlaylistModule(fakeChannel);

        it('rejects invalid regexes', () => {
            let sentError = false;

            fakeUser.socket.emit = (event, payload) => {
                assert.strictEqual(event, 'errorMsg');
                assert.deepStrictEqual(payload, {
                    msg: "Invalid target: -i * -m"
                });
                sentError = true;
            };

            playlistModule.handleClean(fakeUser, "/clean -i * -m", {});

            assert(sentError, 'Expected error due to invalid regex');
        });
    });
});
