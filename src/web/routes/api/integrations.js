const express = require('express');
const webserver = require('../../webserver');
const Config = require('../../../config');
const showsDB = require('../../../database/shows');
const calendarDB = require('../../../database/calendar-integrations');
const googleCalendar = require('../../../integrations/google-calendar');
const { getChannelRow, getUserEffectiveRank } = require('./middleware');

const router = express.Router({ mergeParams: true });

const PROVIDERS = new Set(['google']);
const SYNCABLE_STATUSES = new Set(['scheduled', 'running', 'paused', 'completed']);
const CHANNEL_SYNC_COOLDOWN_MS = 30 * 1000;
const GOOGLE_QUEUE_MIN_INTERVAL_MS = 250;
const CHANNEL_SYNC_STATE = new Map();
let googleQueue = Promise.resolve();
let nextGoogleRequestAt = 0;

function sanitizeIntegration(integration) {
    return {
        id: integration.id,
        provider: integration.provider,
        status: integration.status,
        config: integration.config || {},
        token_expires_at: integration.token_expires_at,
        last_sync_at: integration.last_sync_at,
        last_error: integration.last_error,
        connected_by: integration.connected_by,
        updated_by: integration.updated_by,
        created_at: integration.created_at,
        updated_at: integration.updated_at
    };
}

async function authorizeChannelAdmin(req, res, minRank = 3) {
    const user = await webserver.authorize(req);
    if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }

    let channelRow;
    try {
        channelRow = await getChannelRow(req.params.channel);
    } catch (_err) {
        res.status(404).json({ error: 'Channel not found' });
        return null;
    }

    const rank = await getUserEffectiveRank(user, channelRow);
    if (rank < minRank) {
        res.status(403).json({ error: 'Insufficient rank' });
        return null;
    }

    return { user, rank, channelRow };
}

async function ensureAccessToken(integration) {
    const unpacked = googleCalendar.unpackTokens(integration);
    if (unpacked.accessToken && unpacked.tokenExpiresAt > Date.now() + 60 * 1000) {
        return { accessToken: unpacked.accessToken, updatedPatch: null };
    }
    if (!unpacked.refreshToken) {
        throw new Error('Integration token expired and no refresh token is available');
    }

    const refreshed = await googleCalendar.refreshAccessToken(unpacked.refreshToken);
    const packed = googleCalendar.packTokens({
        access_token: refreshed.access_token,
        refresh_token: unpacked.refreshToken,
        expires_in: refreshed.expires_in
    });
    return {
        accessToken: refreshed.access_token,
        updatedPatch: packed
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetryGoogleError(err) {
    if (!err) return false;
    const code = Number(err.statusCode || 0);
    if (code === 429 || code === 503) return true;
    if (code === 403) {
        const msg = String(err.message || '').toLowerCase();
        return msg.indexOf('quota') !== -1 || msg.indexOf('rate') !== -1;
    }
    return false;
}

async function withGoogleBackoff(op, maxRetries = 4) {
    let attempt = 0;
    while (true) {
        try {
            return await op();
        } catch (err) {
            if (!shouldRetryGoogleError(err) || attempt >= maxRetries) {
                throw err;
            }
            const retryAfterMs = Number(err.retryAfterMs || 0);
            const baseMs = Math.min(20000, 1000 * Math.pow(2, attempt));
            const jitterMs = Math.floor(Math.random() * 500);
            await sleep(Math.max(retryAfterMs, baseMs + jitterMs));
            attempt++;
        }
    }
}

function runInGoogleQueue(task) {
    const runner = async () => {
        const wait = nextGoogleRequestAt - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }
        try {
            return await task();
        } finally {
            nextGoogleRequestAt = Date.now() + GOOGLE_QUEUE_MIN_INTERVAL_MS;
        }
    };

    const p = googleQueue.then(runner, runner);
    googleQueue = p.catch(() => {});
    return p;
}

function toMillis(input) {
    if (!input) return null;
    const ms = Date.parse(input);
    return isNaN(ms) ? null : ms;
}

async function refreshGoogleEventIndex({ integration, calendarId, accessToken }) {
    const now = Date.now();
    const config = integration.config || {};
    let syncToken = config.google_sync_token || null;
    let pageToken = null;
    let nextSyncToken = syncToken;

    while (true) {
        let resp;
        try {
            resp = await withGoogleBackoff(() =>
                googleCalendar.listGoogleCalendarEvents(accessToken, calendarId, {
                    syncToken,
                    pageToken
                })
            );
        } catch (err) {
            if (Number(err.statusCode || 0) === 410 && syncToken) {
                syncToken = null;
                pageToken = null;
                nextSyncToken = null;
                continue;
            }
            throw err;
        }

        const items = Array.isArray(resp.items) ? resp.items : [];
        for (const ev of items) {
            const p = ev && ev.extendedProperties && ev.extendedProperties.private
                ? ev.extendedProperties.private
                : {};
            const source = String((p && p.source) || '').toLowerCase();
            const showId = p && p.show_id ? parseInt(p.show_id, 10) : null;
            if (source !== 'veretube-sync' && (isNaN(showId) || !showId)) {
                continue;
            }
            await calendarDB.upsertGoogleEventIndexRow({
                channel_id: integration.channel_id,
                integration_id: integration.id,
                show_id: isNaN(showId) ? null : showId,
                external_event_id: ev.id,
                external_etag: ev.etag || null,
                start_at: ev.start && ev.start.dateTime ? toMillis(ev.start.dateTime) : null,
                updated_remote_at: ev.updated ? toMillis(ev.updated) : null,
                last_seen_at: now,
                deleted_remote: ev.status === 'cancelled'
            });
        }

        pageToken = resp.nextPageToken || null;
        if (resp.nextSyncToken) {
            nextSyncToken = resp.nextSyncToken;
        }
        if (!pageToken) {
            break;
        }
    }

    const nextConfig = Object.assign({}, config, {
        google_sync_token: nextSyncToken || null
    });
    await calendarDB.updateIntegrationConfig(integration.id, nextConfig);
}

async function syncGoogleIntegration({ integration, channelRow }) {
    const config = integration.config || {};
    const calendarId = config.calendar_id;
    if (!calendarId) {
        throw new Error('Integration missing calendar_id');
    }

    const statuses = Array.isArray(config.sync_statuses) && config.sync_statuses.length > 0
        ? config.sync_statuses.filter(s => SYNCABLE_STATUSES.has(s))
        : ['scheduled', 'running', 'paused', 'completed'];

    const allShows = await showsDB.listShows(channelRow.id);
    const shows = allShows.filter(show => statuses.indexOf(show.status) >= 0);
    const localById = new Map();
    shows.forEach(show => localById.set(show.id, show));
    const tokenResult = await ensureAccessToken(integration);
    await refreshGoogleEventIndex({
        integration,
        calendarId,
        accessToken: tokenResult.accessToken
    });

    const indexRows = await calendarDB.listGoogleEventIndex(integration.id);
    const existingMappings = await calendarDB.listExternalEventsForIntegration(channelRow.id, integration.id);
    const remoteByShowId = new Map();
    const staleRemote = [];
    indexRows.forEach(row => {
        if (row.deleted_remote) return;
        if (row.show_id && localById.has(row.show_id)) {
            remoteByShowId.set(row.show_id, row);
            return;
        }
        staleRemote.push(row);
    });

    let syncedCount = 0;

    for (const show of shows) {
        const remote = remoteByShowId.get(show.id) || null;
        const mapping = existingMappings.find(m => m.show_id === show.id) ||
            await calendarDB.getExternalEvent(show.id, integration.id);
        const needsUpdate = !remote ||
            !remote.external_etag ||
            Number(remote.updated_at || 0) < Number(show.updated_at || 0);
        let event;
        if (!remote) {
            event = await withGoogleBackoff(() =>
                googleCalendar.upsertGoogleCalendarEvent(tokenResult.accessToken, calendarId, show)
            );
        } else {
            if (!needsUpdate) {
                if (!mapping) {
                    await calendarDB.upsertExternalEvent({
                        channelId: channelRow.id,
                        showId: show.id,
                        integrationId: integration.id,
                        provider: 'google',
                        externalEventId: remote.external_event_id,
                        externalEtag: remote.external_etag || null
                    });
                }
                continue;
            }
            event = await withGoogleBackoff(() =>
                googleCalendar.updateGoogleCalendarEvent(
                    tokenResult.accessToken,
                    calendarId,
                    remote.external_event_id,
                    show
                )
            );
        }
        await calendarDB.upsertExternalEvent({
            channelId: channelRow.id,
            showId: show.id,
            integrationId: integration.id,
            provider: 'google',
            externalEventId: event.id,
            externalEtag: event.etag || null
        });
        await calendarDB.upsertGoogleEventIndexRow({
            channel_id: channelRow.id,
            integration_id: integration.id,
            show_id: show.id,
            external_event_id: event.id,
            external_etag: event.etag || null,
            start_at: Number(show.scheduled_for || 0) || null,
            updated_remote_at: Date.now(),
            last_seen_at: Date.now(),
            deleted_remote: false
        });
        syncedCount++;
    }

    for (const remote of staleRemote) {
        if (remote.external_event_id) {
            await withGoogleBackoff(() =>
                googleCalendar.deleteGoogleCalendarEvent(
                    tokenResult.accessToken,
                    calendarId,
                    remote.external_event_id
                )
            );
        }
        await calendarDB.deleteGoogleEventIndexRow(remote.id, integration.id);
        if (remote.show_id) {
            const mapped = await calendarDB.getExternalEvent(remote.show_id, integration.id);
            if (mapped) {
                await calendarDB.deleteExternalEvent(mapped.id, channelRow.id, integration.id);
            }
        }
    }

    for (const mapping of existingMappings) {
        if (localById.has(mapping.show_id)) {
            continue;
        }
        const remote = staleRemote.find(r => r.show_id === mapping.show_id);
        if (remote) {
            continue;
        }
        if (mapping.external_event_id) {
            await withGoogleBackoff(() =>
                googleCalendar.deleteGoogleCalendarEvent(
                    tokenResult.accessToken,
                    calendarId,
                    mapping.external_event_id
                )
            );
        }
        await calendarDB.deleteExternalEvent(mapping.id, channelRow.id, integration.id);
    }

    return {
        synced: syncedCount,
        tokenPatch: tokenResult.updatedPatch
    };
}

router.get('/', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 3);
    if (!auth) return;
    const rows = await calendarDB.listByChannel(auth.channelRow.id);
    res.json(rows.map(sanitizeIntegration));
});

router.post('/:provider/connect', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 3);
    if (!auth) return;

    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Unsupported provider' });
    }
    if (provider !== 'google') {
        return res.status(400).json({ error: 'Only google is supported currently' });
    }

    const calendarId = String((req.body && req.body.calendar_id) || '').trim();
    if (!calendarId) {
        return res.status(400).json({ error: 'calendar_id is required' });
    }

    try {
        googleCalendar.assertConfigured();
        const state = googleCalendar.encodeState({
            channel: auth.channelRow.name,
            channelId: auth.channelRow.id,
            calendarId,
            actor: auth.user.name,
            exp: Date.now() + 10 * 60 * 1000
        }, Config.get('http.cookie-secret'));
        const authUrl = googleCalendar.buildAuthUrl(state);
        res.json({ auth_url: authUrl });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Unable to initialize oauth flow' });
    }
});

router.post('/:provider/disconnect', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 3);
    if (!auth) return;
    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Unsupported provider' });
    }

    const integration = await calendarDB.getByChannelProvider(auth.channelRow.id, provider);
    if (!integration) return res.status(404).json({ error: 'Integration not found' });
    await calendarDB.disconnectIntegration(integration.id, auth.channelRow.id, auth.user.name);
    res.json({ success: true });
});

router.post('/:provider/sync-now', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 3);
    if (!auth) return;
    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Unsupported provider' });
    }

    const integration = await calendarDB.getByChannelProvider(auth.channelRow.id, provider);
    if (!integration || integration.status !== 'connected') {
        return res.status(404).json({ error: 'Connected integration not found' });
    }

    const lockKey = `${auth.channelRow.id}:${provider}`;
    const now = Date.now();
    const current = CHANNEL_SYNC_STATE.get(lockKey) || { inFlight: false, lastRunAt: 0 };
    if (current.inFlight) {
        return res.status(409).json({ error: 'Sync already in progress for this channel' });
    }
    if (now - current.lastRunAt < CHANNEL_SYNC_COOLDOWN_MS) {
        const retryAfterMs = CHANNEL_SYNC_COOLDOWN_MS - (now - current.lastRunAt);
        return res.status(429).json({
            error: 'Sync cooldown active for this channel',
            retry_after_ms: retryAfterMs
        });
    }

    CHANNEL_SYNC_STATE.set(lockKey, { inFlight: true, lastRunAt: now });

    try {
        let result;
        if (provider === 'google') {
            result = await runInGoogleQueue(() =>
                syncGoogleIntegration({ integration, channelRow: auth.channelRow })
            );
        }
        const patch = Object.assign({
            status: 'connected',
            last_sync_at: Date.now(),
            last_error: null
        }, result && result.tokenPatch ? result.tokenPatch : {});
        await calendarDB.updateIntegrationSyncResult(integration.id, patch);
        res.json({ success: true, synced: result ? result.synced : 0 });
    } catch (err) {
        await calendarDB.updateIntegrationSyncResult(integration.id, {
            status: 'error',
            last_sync_at: Date.now(),
            last_error: err.message || 'Sync failed'
        });
        res.status(400).json({ error: err.message || 'Sync failed' });
    } finally {
        const st = CHANNEL_SYNC_STATE.get(lockKey);
        if (st) {
            st.inFlight = false;
            CHANNEL_SYNC_STATE.set(lockKey, st);
        }
    }
});

module.exports = router;
