/*
    bgtask.js

    Registers background jobs to run periodically while the server is
    running.
*/

var Config = require("./config");
var db = require("./database");
var Promise = require("bluebird");
const shows = require('./shows');
const showNotifications = require('./show-notifications');
const calendarDB = require('./database/calendar-integrations');
const integrationsApi = require('./web/routes/api/integrations');

const LOGGER = require('@calzoneman/jsli')('bgtask');

var init = null;

/* Alias cleanup */
function initAliasCleanup() {
    var CLEAN_INTERVAL = parseInt(Config.get("aliases.purge-interval"));
    var CLEAN_EXPIRE = parseInt(Config.get("aliases.max-age"));

    setInterval(function () {
        db.cleanOldAliases(CLEAN_EXPIRE, function (err) {
            LOGGER.info("Cleaned old aliases");
            if (err)
                LOGGER.error(err);
        });
    }, CLEAN_INTERVAL);
}

/* Password reset cleanup */
function initPasswordResetCleanup() {
    var CLEAN_INTERVAL = 8*60*60*1000;

    setInterval(function () {
        db.cleanOldPasswordResets(function (err) {
            if (err)
                LOGGER.error(err);
        });
    }, CLEAN_INTERVAL);
}

function initChannelDumper(Server) {
    const chanPath = Config.get('channel-path');
    var CHANNEL_SAVE_INTERVAL = parseInt(Config.get("channel-save-interval"))
                                * 60000;
    setInterval(function () {
        if (Server.channels.length === 0) {
            return;
        }

        var wait = CHANNEL_SAVE_INTERVAL / Server.channels.length;
        LOGGER.info(`Saving channels with delay ${wait}`);
        Promise.reduce(Server.channels, (_, chan) => {
            return Promise.delay(wait).then(async () => {
                if (!chan.dead && chan.users && chan.users.length > 0) {
                    try {
                        await chan.saveState();
                        LOGGER.info(`Saved /${chanPath}/${chan.name}`);
                    } catch (error) {
                        LOGGER.error(
                            'Failed to save /%s/%s: %s',
                            chanPath,
                            chan ? chan.name : '<undefined>',
                            error.stack
                        );
                    }
                }
            }).catch(error => {
                LOGGER.error(`Failed to save channel: ${error.stack}`);
            });
        }, 0).catch(error => {
            LOGGER.error(`Failed to save channels: ${error.stack}`);
        });
    }, CHANNEL_SAVE_INTERVAL);
}

function initAccountCleanup() {
    setInterval(() => {
        (async () => {
            let rows = await db.users.findAccountsPendingDeletion();
            for (let row of rows) {
                try {
                    await db.users.purgeAccount(row.id);
                    LOGGER.info('Purged account from request %j', row);
                } catch (error) {
                    LOGGER.error('Error purging account %j: %s', row, error.stack);
                }
            }
        })().catch(error => {
            LOGGER.error('Error purging deleted accounts: %s', error.stack);
        });
    }, 3600 * 1000);
}

function initShowScheduler() {
    var SCHEDULE_INTERVAL = 15 * 1000;
    var running = false;

    setInterval(async () => {
        if (running) {
            return;
        }

        running = true;
        try {
            await showNotifications.pollAndSendDueNotifications();
            await shows.pollAndRunDueShows();
        } catch (error) {
            LOGGER.error('Show scheduler failure: %s', error.stack || error);
        } finally {
            running = false;
        }
    }, SCHEDULE_INTERVAL);
}

function initCalendarAutoSyncScheduler() {
    const AUTO_SYNC_INTERVAL_MS = 60 * 1000;
    const AUTO_SYNC_PERIOD_MINUTES = 30;
    let running = false;

    function inStaggerSlot(integrationId, now) {
        const slot = Number(integrationId || 0) % AUTO_SYNC_PERIOD_MINUTES;
        const minute = new Date(now).getUTCMinutes() % AUTO_SYNC_PERIOD_MINUTES;
        return slot === minute;
    }

    setInterval(async () => {
        if (running) {
            return;
        }

        running = true;
        try {
            const now = Date.now();
            const rows = await calendarDB.listConnectedByProvider('google');
            for (const integration of rows) {
                if (!inStaggerSlot(integration.id, now)) {
                    continue;
                }
                if (integration.last_sync_at && now - integration.last_sync_at < AUTO_SYNC_PERIOD_MINUTES * 60 * 1000) {
                    continue;
                }

                try {
                    await integrationsApi.syncIntegrationNow({
                        provider: 'google',
                        integration,
                        channelRow: { id: integration.channel_id },
                        enforceCooldown: false
                    });
                } catch (err) {
                    LOGGER.warn(
                        'Auto calendar sync failed integration=%s channel=%s: %s',
                        integration.id,
                        integration.channel_id,
                        err && (err.stack || err.message) || err
                    );
                }
            }
        } catch (err) {
            LOGGER.error('Calendar auto-sync scheduler failure: %s', err.stack || err);
        } finally {
            running = false;
        }
    }, AUTO_SYNC_INTERVAL_MS);
}

module.exports = function (Server) {
    if (init === Server) {
        LOGGER.warn("Attempted to re-init background tasks");
        return;
    }

    init = Server;
    initAliasCleanup();
    initChannelDumper(Server);
    initPasswordResetCleanup();
    initAccountCleanup();
    initShowScheduler();
    initCalendarAutoSyncScheduler();
};
