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
        name: row.name,
        status: row.status,
        config,
        token_encrypted: row.token_encrypted || null,
        last_error: row.last_error || null,
        connected_by: row.connected_by || null,
        updated_by: row.updated_by || null,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function parseDeliveryRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        channel_id: row.channel_id,
        show_id: row.show_id,
        integration_id: row.integration_id,
        provider: row.provider,
        occurrence_at: row.occurrence_at,
        offset_minutes: row.offset_minutes,
        status: row.status,
        attempts: row.attempts,
        last_attempt_at: row.last_attempt_at || null,
        sent_at: row.sent_at || null,
        last_error: row.last_error || null,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function listByChannel(channelId) {
    const rows = await knex()('channel_notification_integrations')
        .where({ channel_id: channelId })
        .orderBy('provider', 'asc')
        .orderBy('name', 'asc')
        .select();
    return rows.map(parseIntegrationRow);
}

async function listConnectedByChannel(channelId) {
    const rows = await knex()('channel_notification_integrations')
        .where({ channel_id: channelId, status: 'connected' })
        .orderBy('provider', 'asc')
        .orderBy('name', 'asc')
        .select();
    return rows.map(parseIntegrationRow);
}

async function getById(id, channelId) {
    const rows = await knex()('channel_notification_integrations')
        .where({ id, channel_id: channelId })
        .limit(1)
        .select();
    return parseIntegrationRow(rows[0]);
}

async function createIntegration(channelId, payload) {
    const now = Date.now();
    const [id] = await knex()('channel_notification_integrations').insert({
        channel_id: channelId,
        provider: payload.provider,
        name: payload.name,
        status: payload.status || 'connected',
        config_json: JSON.stringify(payload.config || {}),
        token_encrypted: payload.token_encrypted || null,
        last_error: payload.last_error || null,
        connected_by: payload.connected_by || null,
        updated_by: payload.updated_by || null,
        created_at: now,
        updated_at: now
    });
    return id;
}

async function updateIntegration(id, channelId, payload) {
    const patch = {
        name: payload.name,
        status: payload.status || 'connected',
        config_json: JSON.stringify(payload.config || {}),
        token_encrypted: payload.token_encrypted || null,
        last_error: payload.last_error || null,
        updated_by: payload.updated_by || null,
        updated_at: Date.now()
    };
    await knex()('channel_notification_integrations')
        .where({ id, channel_id: channelId })
        .update(patch);
}

async function disconnectIntegration(id, channelId, updatedBy) {
    await knex()('channel_notification_integrations')
        .where({ id, channel_id: channelId })
        .update({
            status: 'disconnected',
            token_encrypted: null,
            last_error: null,
            updated_by: updatedBy || null,
            updated_at: Date.now()
        });
}

async function updateIntegrationError(id, error) {
    await knex()('channel_notification_integrations')
        .where({ id })
        .update({
            status: error ? 'error' : 'connected',
            last_error: error || null,
            updated_at: Date.now()
        });
}

async function getDelivery({ showId, integrationId, occurrenceAt, offsetMinutes }) {
    const rows = await knex()('channel_show_notification_deliveries')
        .where({
            show_id: showId,
            integration_id: integrationId,
            occurrence_at: occurrenceAt,
            offset_minutes: offsetMinutes
        })
        .limit(1)
        .select();
    return parseDeliveryRow(rows[0]);
}

async function createDelivery(row) {
    const now = Date.now();
    try {
        const [id] = await knex()('channel_show_notification_deliveries').insert({
            channel_id: row.channelId,
            show_id: row.showId,
            integration_id: row.integrationId,
            provider: row.provider,
            occurrence_at: row.occurrenceAt,
            offset_minutes: row.offsetMinutes,
            status: 'pending',
            attempts: 0,
            created_at: now,
            updated_at: now
        });
        return parseDeliveryRow({
            id,
            channel_id: row.channelId,
            show_id: row.showId,
            integration_id: row.integrationId,
            provider: row.provider,
            occurrence_at: row.occurrenceAt,
            offset_minutes: row.offsetMinutes,
            status: 'pending',
            attempts: 0,
            created_at: now,
            updated_at: now
        });
    } catch (err) {
        const code = err && String(err.code || '');
        if (code === 'ER_DUP_ENTRY' || code.indexOf('CONSTRAINT') !== -1) {
            return getDelivery(row);
        }
        throw err;
    }
}

async function markDeliverySent(id) {
    await knex()('channel_show_notification_deliveries')
        .where({ id })
        .update({
            status: 'sent',
            attempts: knex().raw('attempts + 1'),
            last_attempt_at: Date.now(),
            sent_at: Date.now(),
            last_error: null,
            updated_at: Date.now()
        });
}

async function markDeliveryFailed(id, error) {
    await knex()('channel_show_notification_deliveries')
        .where({ id })
        .update({
            status: 'failed',
            attempts: knex().raw('attempts + 1'),
            last_attempt_at: Date.now(),
            last_error: String(error || 'Delivery failed').substring(0, 4000),
            updated_at: Date.now()
        });
}

async function listShowsWithDueNotificationWindow({ earliestOccurrenceAt, latestOccurrenceAt }) {
    const rows = await knex()('channel_shows')
        .join('channels', 'channel_shows.channel_id', 'channels.id')
        .whereIn('channel_shows.status', ['scheduled', 'running', 'completed'])
        .andWhere('channel_shows.next_run_at', '>=', earliestOccurrenceAt)
        .andWhere('channel_shows.next_run_at', '<=', latestOccurrenceAt)
        .select('channel_shows.*', 'channels.name as channel_name');
    return rows;
}

module.exports = {
    listByChannel,
    listConnectedByChannel,
    getById,
    createIntegration,
    updateIntegration,
    disconnectIntegration,
    updateIntegrationError,
    getDelivery,
    createDelivery,
    markDeliverySent,
    markDeliveryFailed,
    listShowsWithDueNotificationWindow
};
