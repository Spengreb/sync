const db = require('../database');

function knex() {
    return db.getDB().knex;
}

function parseIntegrationRow(row) {
    if (!row) return null;
    let config = {};
    try {
        config = row.config_json ? JSON.parse(row.config_json) : {};
    } catch (_err) {
        config = {};
    }

    return {
        id: row.id,
        channel_id: row.channel_id,
        provider: row.provider,
        status: row.status,
        config,
        token_encrypted: row.token_encrypted || null,
        refresh_token_encrypted: row.refresh_token_encrypted || null,
        token_expires_at: row.token_expires_at || null,
        last_sync_at: row.last_sync_at || null,
        last_error: row.last_error || null,
        connected_by: row.connected_by || null,
        updated_by: row.updated_by || null,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function listByChannel(channelId) {
    const rows = await knex()('channel_calendar_integrations')
        .where({ channel_id: channelId })
        .orderBy('provider', 'asc')
        .select();
    return rows.map(parseIntegrationRow);
}

async function getByChannelProvider(channelId, provider) {
    const rows = await knex()('channel_calendar_integrations')
        .where({ channel_id: channelId, provider })
        .limit(1)
        .select();
    return parseIntegrationRow(rows[0]);
}

async function upsertGoogleIntegration(channelId, payload) {
    const now = Date.now();
    const existing = await getByChannelProvider(channelId, 'google');
    const patch = {
        status: payload.status || 'connected',
        config_json: JSON.stringify(payload.config || {}),
        token_encrypted: payload.token_encrypted || null,
        refresh_token_encrypted: payload.refresh_token_encrypted || null,
        token_expires_at: payload.token_expires_at || null,
        last_error: payload.last_error || null,
        connected_by: payload.connected_by || null,
        updated_by: payload.updated_by || null,
        updated_at: now
    };

    if (!existing) {
        const [id] = await knex()('channel_calendar_integrations').insert({
            channel_id: channelId,
            provider: 'google',
            created_at: now,
            ...patch
        });
        return id;
    }

    await knex()('channel_calendar_integrations')
        .where({ id: existing.id })
        .update(patch);
    return existing.id;
}

async function disconnectIntegration(id, channelId, updatedBy) {
    await knex()('channel_calendar_integrations')
        .where({ id, channel_id: channelId })
        .update({
            status: 'disconnected',
            token_encrypted: null,
            refresh_token_encrypted: null,
            token_expires_at: null,
            last_error: null,
            updated_by: updatedBy || null,
            updated_at: Date.now()
        });
}

async function updateIntegrationSyncResult(id, patch) {
    const update = {
            status: patch.status || 'connected',
            last_sync_at: patch.last_sync_at || Date.now(),
            last_error: patch.last_error || null,
            updated_at: Date.now()
    };
    if (Object.prototype.hasOwnProperty.call(patch, 'token_encrypted')) {
        update.token_encrypted = patch.token_encrypted;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'refresh_token_encrypted')) {
        update.refresh_token_encrypted = patch.refresh_token_encrypted;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'token_expires_at')) {
        update.token_expires_at = patch.token_expires_at;
    }

    await knex()('channel_calendar_integrations')
        .where({ id })
        .update(update);
}

async function updateIntegrationConfig(id, config) {
    await knex()('channel_calendar_integrations')
        .where({ id })
        .update({
            config_json: JSON.stringify(config || {}),
            updated_at: Date.now()
        });
}

function parseExternalRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        channel_id: row.channel_id,
        show_id: row.show_id,
        integration_id: row.integration_id,
        provider: row.provider,
        external_event_id: row.external_event_id,
        external_etag: row.external_etag || null,
        last_pushed_at: row.last_pushed_at || null
    };
}

async function getExternalEvent(showId, integrationId) {
    const rows = await knex()('channel_show_external_events')
        .where({ show_id: showId, integration_id: integrationId })
        .limit(1)
        .select();
    return parseExternalRow(rows[0]);
}

async function listExternalEventsForIntegration(channelId, integrationId) {
    const rows = await knex()('channel_show_external_events')
        .where({ channel_id: channelId, integration_id: integrationId, provider: 'google' })
        .select();
    return rows.map(parseExternalRow);
}

async function upsertExternalEvent({ channelId, showId, integrationId, provider, externalEventId, externalEtag }) {
    const now = Date.now();
    const existing = await getExternalEvent(showId, integrationId);
    if (!existing) {
        await knex()('channel_show_external_events').insert({
            channel_id: channelId,
            show_id: showId,
            integration_id: integrationId,
            provider,
            external_event_id: externalEventId,
            external_etag: externalEtag || null,
            last_pushed_at: now,
            created_at: now,
            updated_at: now
        });
        return;
    }

    await knex()('channel_show_external_events')
        .where({ id: existing.id })
        .update({
            external_event_id: externalEventId,
            external_etag: externalEtag || null,
            last_pushed_at: now,
            updated_at: now
        });
}

async function deleteExternalEvent(id, channelId, integrationId) {
    await knex()('channel_show_external_events')
        .where({ id, channel_id: channelId, integration_id: integrationId })
        .delete();
}

function parseGoogleIndexRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        channel_id: row.channel_id,
        integration_id: row.integration_id,
        show_id: row.show_id || null,
        external_event_id: row.external_event_id,
        external_etag: row.external_etag || null,
        start_at: row.start_at || null,
        updated_remote_at: row.updated_remote_at || null,
        last_seen_at: row.last_seen_at || null,
        deleted_remote: !!row.deleted_remote,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function listGoogleEventIndex(integrationId) {
    const rows = await knex()('channel_google_event_index')
        .where({ integration_id: integrationId })
        .select();
    return rows.map(parseGoogleIndexRow);
}

async function upsertGoogleEventIndexRow(row) {
    const now = Date.now();
    const existing = await knex()('channel_google_event_index')
        .where({
            integration_id: row.integration_id,
            external_event_id: row.external_event_id
        })
        .limit(1)
        .select();

    if (!existing || existing.length === 0) {
        await knex()('channel_google_event_index').insert({
            channel_id: row.channel_id,
            integration_id: row.integration_id,
            show_id: row.show_id || null,
            external_event_id: row.external_event_id,
            external_etag: row.external_etag || null,
            start_at: row.start_at || null,
            updated_remote_at: row.updated_remote_at || null,
            last_seen_at: row.last_seen_at || now,
            deleted_remote: row.deleted_remote ? 1 : 0,
            created_at: now,
            updated_at: now
        });
        return;
    }

    await knex()('channel_google_event_index')
        .where({ id: existing[0].id })
        .update({
            show_id: row.show_id || null,
            external_etag: row.external_etag || null,
            start_at: row.start_at || null,
            updated_remote_at: row.updated_remote_at || null,
            last_seen_at: row.last_seen_at || now,
            deleted_remote: row.deleted_remote ? 1 : 0,
            updated_at: now
        });
}

async function deleteGoogleEventIndexRow(id, integrationId) {
    await knex()('channel_google_event_index')
        .where({ id, integration_id: integrationId })
        .delete();
}

function buildGoogleCalendarUrl(calendarId) {
    return `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(calendarId)}`;
}

function buildGoogleEventUrl(eventId, calendarId) {
    const raw = `${eventId} ${calendarId}`;
    const eid = Buffer.from(raw, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return `https://calendar.google.com/calendar/u/0/r/eventedit/${eid}`;
}

async function getGoogleLinksForShows(channelId, showIds) {
    if (!Array.isArray(showIds) || showIds.length === 0) {
        return {};
    }

    const integration = await getByChannelProvider(channelId, 'google');
    if (!integration || integration.status !== 'connected' || !integration.last_sync_at) {
        return {};
    }

    const calendarId = integration.config && integration.config.calendar_id
        ? String(integration.config.calendar_id).trim()
        : '';
    if (!calendarId) {
        return {};
    }

    const rows = await knex()('channel_show_external_events')
        .where({
            channel_id: channelId,
            integration_id: integration.id,
            provider: 'google'
        })
        .whereIn('show_id', showIds)
        .select('show_id', 'external_event_id');

    const calendarUrl = buildGoogleCalendarUrl(calendarId);
    const links = {};
    showIds.forEach(showId => {
        links[showId] = { calendar_url: calendarUrl };
    });

    rows.forEach(row => {
        if (!links[row.show_id]) {
            links[row.show_id] = { calendar_url: calendarUrl };
        }
        if (row.external_event_id) {
            links[row.show_id].event_url = buildGoogleEventUrl(row.external_event_id, calendarId);
        }
    });

    return links;
}

module.exports = {
    listByChannel,
    getByChannelProvider,
    upsertGoogleIntegration,
    disconnectIntegration,
    updateIntegrationSyncResult,
    updateIntegrationConfig,
    getExternalEvent,
    listExternalEventsForIntegration,
    upsertExternalEvent,
    deleteExternalEvent,
    listGoogleEventIndex,
    upsertGoogleEventIndexRow,
    deleteGoogleEventIndexRow,
    getGoogleLinksForShows
};
