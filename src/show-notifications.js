const LOGGER = require('@calzoneman/jsli')('show-notifications');
const Config = require('./config');
const notificationDB = require('./database/notification-integrations');
const discord = require('./integrations/discord');
const ntfy = require('./integrations/ntfy');

const SEND_LOOKBACK_MS = 10 * 60 * 1000;
const MAX_OFFSET_MINUTES = 7 * 24 * 60;
const MAX_ATTEMPTS = 3;

function parseNotificationPlan(raw) {
    try {
        const parsed = raw && typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsed && Array.isArray(parsed.steps) ? parsed : { steps: [] };
    } catch (_err) {
        return { steps: [] };
    }
}

function buildShowUrl(show) {
    const base = Config.get('https.enabled')
        ? Config.get('https.domain')
        : Config.get('io.domain');
    const channelPath = String(Config.get('channel-path') || 'r').replace(/^\/+|\/+$/g, '');
    return `${String(base || '').replace(/\/+$/g, '')}/${channelPath}/${encodeURIComponent(show.channel_name)}`;
}

function formatTimeUntil(offsetMinutes) {
    const minutes = Number(offsetMinutes || 0);
    if (minutes <= 0) return 'now';
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function stripMarkdown(text) {
    return String(text || '')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/[`*_#>]/g, '')
        .trim();
}

function formatNotesForNotification(text) {
    return String(text || '')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
            const label = String(alt || '').trim();
            return label ? `${label}\n${url}` : url;
        })
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
        .replace(/[`*_#>]/g, '')
        .trim();
}

function renderMessage(template, show, step, occurrenceAt) {
    const start = new Date(occurrenceAt);
    const notesMarkdown = String(show.notes || '').trim();
    const notes = formatNotesForNotification(notesMarkdown);
    const notesText = stripMarkdown(notesMarkdown);
    const replacements = {
        show_name: show.name || '',
        channel_name: show.channel_name || '',
        start_time: start.toLocaleString('en-US', { timeZone: show.timezone || 'UTC' }),
        time_until: formatTimeUntil(step.offset_minutes),
        show_url: buildShowUrl(show),
        notes,
        note: notes,
        show_notes: notes,
        notes_text: notesText,
        note_text: notesText,
        show_notes_text: notesText,
        notes_markdown: notesMarkdown,
        note_markdown: notesMarkdown,
        show_notes_markdown: notesMarkdown
    };

    let message = String(template || '').trim();
    if (!message) {
        message = step.offset_minutes > 0
            ? '{show_name} starts in {time_until}.\n{show_url}'
            : '{show_name} is starting now.\n{show_url}';
    }

    Object.keys(replacements).forEach(key => {
        message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), replacements[key]);
    });
    return message.substring(0, 4000);
}

function parseShowRow(row) {
    return {
        id: row.id,
        channel_id: row.channel_id,
        channel_name: row.channel_name,
        name: row.name,
        notes: row.notes || '',
        timezone: row.timezone || 'UTC',
        next_run_at: Number(row.next_run_at || row.scheduled_for || 0),
        notification_plan: parseNotificationPlan(row.notification_plan)
    };
}

function targetIdSet(step) {
    return new Set((Array.isArray(step.target_ids) ? step.target_ids : [])
        .map(id => String(id || '').trim())
        .filter(id => id));
}

async function sendToIntegration(integration, message, show) {
    if (integration.provider === 'ntfy') {
        return ntfy.publish(integration, message, {
            title: integration.config && integration.config.title
                ? integration.config.title
                : show.name,
            click: buildShowUrl(show)
        });
    }
    if (integration.provider === 'discord') {
        return discord.publish(integration, message);
    }
    throw new Error(`Unsupported notification provider: ${integration.provider}`);
}

async function deliverStepTarget({ show, step, integration, occurrenceAt }) {
    const delivery = await notificationDB.createDelivery({
        channelId: show.channel_id,
        showId: show.id,
        integrationId: integration.id,
        provider: integration.provider,
        occurrenceAt,
        offsetMinutes: step.offset_minutes
    });

    if (!delivery || delivery.status === 'sent' || Number(delivery.attempts || 0) >= MAX_ATTEMPTS) {
        return;
    }

    const message = renderMessage(step.message, show, step, occurrenceAt);
    try {
        await sendToIntegration(integration, message, show);
        await notificationDB.markDeliverySent(delivery.id);
        await notificationDB.updateIntegrationError(integration.id, null);
    } catch (err) {
        const message = err && (err.message || err.stack) || err;
        await notificationDB.markDeliveryFailed(delivery.id, message);
        await notificationDB.updateIntegrationError(integration.id, String(message).substring(0, 4000));
        LOGGER.warn(
            'Show notification failed show=%s integration=%s provider=%s: %s',
            show.id,
            integration.id,
            integration.provider,
            message
        );
    }
}

async function pollAndSendDueNotifications() {
    const now = Date.now();
    const rows = await notificationDB.listShowsWithDueNotificationWindow({
        earliestOccurrenceAt: now - SEND_LOOKBACK_MS,
        latestOccurrenceAt: now + (MAX_OFFSET_MINUTES * 60 * 1000)
    });

    for (const row of rows) {
        const show = parseShowRow(row);
        if (!show.next_run_at) continue;
        const plan = show.notification_plan;
        if (!plan.steps.length) continue;

        const integrations = await notificationDB.listConnectedByChannel(show.channel_id);
        if (!integrations.length) continue;
        const integrationsById = new Map();
        integrations.forEach(integration => integrationsById.set(String(integration.id), integration));

        for (const rawStep of plan.steps) {
            const step = {
                offset_minutes: Math.max(0, parseInt(rawStep.offset_minutes, 10) || 0),
                message: String(rawStep.message || ''),
                target_ids: rawStep.target_ids || []
            };
            const dueAt = show.next_run_at - (step.offset_minutes * 60 * 1000);
            if (dueAt > now || dueAt < now - SEND_LOOKBACK_MS) {
                continue;
            }

            const ids = targetIdSet(step);
            for (const id of ids) {
                const integration = integrationsById.get(id);
                if (!integration) continue;
                await deliverStepTarget({
                    show,
                    step,
                    integration,
                    occurrenceAt: show.next_run_at
                });
            }
        }
    }
}

async function sendTestNotifications({ channelRow, show, step }) {
    const integrations = await notificationDB.listConnectedByChannel(channelRow.id);
    const integrationsById = new Map();
    integrations.forEach(integration => integrationsById.set(String(integration.id), integration));

    const targetIds = Array.from(targetIdSet(step));
    const occurrenceAt = Number(show.scheduled_for || show.next_run_at || Date.now());
    const testShow = {
        id: show.id || 0,
        channel_id: channelRow.id,
        channel_name: channelRow.name,
        name: show.name || 'Test Show',
        notes: show.notes || '',
        timezone: show.timezone || 'UTC'
    };
    const normalizedStep = {
        offset_minutes: Math.max(0, parseInt(step.offset_minutes, 10) || 0),
        message: String(step.message || ''),
        target_ids: targetIds
    };
    const rendered = renderMessage(normalizedStep.message, testShow, normalizedStep, occurrenceAt);
    const sent = [];
    const failed = [];

    for (const id of targetIds) {
        const integration = integrationsById.get(id);
        if (!integration) {
            failed.push({ id, error: 'Target is not connected' });
            continue;
        }

        try {
            await sendToIntegration(integration, rendered, testShow);
            await notificationDB.updateIntegrationError(integration.id, null);
            sent.push({ id, name: integration.name, provider: integration.provider });
        } catch (err) {
            const message = err && (err.message || err.stack) || err;
            await notificationDB.updateIntegrationError(integration.id, String(message).substring(0, 4000));
            failed.push({
                id,
                name: integration.name,
                provider: integration.provider,
                error: String(message)
            });
        }
    }

    return { sent, failed, message: rendered };
}

module.exports = {
    pollAndSendDueNotifications,
    renderMessage,
    sendTestNotifications
};
