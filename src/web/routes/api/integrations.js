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
    const tokenResult = await ensureAccessToken(integration);

    for (const show of shows) {
        const mapping = await calendarDB.getExternalEvent(show.id, integration.id);
        let event;
        if (!mapping) {
            event = await googleCalendar.upsertGoogleCalendarEvent(tokenResult.accessToken, calendarId, show);
        } else {
            event = await googleCalendar.updateGoogleCalendarEvent(
                tokenResult.accessToken,
                calendarId,
                mapping.external_event_id,
                show
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
    }

    return {
        synced: shows.length,
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

    try {
        let result;
        if (provider === 'google') {
            result = await syncGoogleIntegration({ integration, channelRow: auth.channelRow });
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
    }
});

module.exports = router;
