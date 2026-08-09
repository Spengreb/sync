const express = require('express');
const webserver = require('../../webserver');
const notificationDB = require('../../../database/notification-integrations');
const customWebhook = require('../../../integrations/custom-webhook');
const discord = require('../../../integrations/discord');
const ntfy = require('../../../integrations/ntfy');
const botDB = require('../../../database/bots');
const { getChannelRow, getUserEffectiveRank, hashToken } = require('./middleware');

const router = express.Router({ mergeParams: true });
const PROVIDERS = new Set(['discord', 'ntfy', 'custom_webhook']);

function sanitizeIntegration(row) {
    return {
        id: row.id,
        provider: row.provider,
        name: row.name,
        status: row.status,
        config: row.config || {},
        last_error: row.last_error,
        connected_by: row.connected_by,
        updated_by: row.updated_by,
        created_at: row.created_at,
        updated_at: row.updated_at
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

async function authorizeChannelRead(req, res, minRank = 2) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        if (!token.startsWith('cbt_')) {
            res.status(401).json({ error: 'Invalid token format' });
            return null;
        }

        const tokenHash = hashToken(token);
        const bot = await botDB.getBotByTokenHash(tokenHash);
        if (!bot) {
            res.status(401).json({ error: 'Invalid or revoked token' });
            return null;
        }

        if (bot.channel_name.toLowerCase() !== req.params.channel.toLowerCase()) {
            res.status(403).json({ error: 'Token not authorized for this channel' });
            return null;
        }

        if (bot.rank < minRank) {
            res.status(403).json({ error: 'Insufficient rank' });
            return null;
        }

        return {
            actorName: bot.name,
            rank: bot.rank,
            channelRow: { id: bot.channel_id, name: bot.channel_name }
        };
    }

    return authorizeChannelAdmin(req, res, minRank);
}

function sanitizeNtfyPayload(body) {
    const name = String((body && body.name) || '').trim();
    if (!name || name.length > 100) {
        return { error: 'name must be 1-100 characters' };
    }

    let serverUrl;
    let topic;
    try {
        serverUrl = ntfy.normalizeServerUrl((body && body.server_url) || 'https://ntfy.sh');
        topic = ntfy.normalizeTopic(body && body.topic);
    } catch (err) {
        return { error: err.message };
    }

    const priority = String((body && body.priority) || '').trim();
    if (priority && !/^(1|2|3|4|5|min|low|default|high|urgent|max)$/i.test(priority)) {
        return { error: 'priority must be blank, 1-5, min, low, default, high, urgent, or max' };
    }

    const tags = String((body && body.tags) || '').trim().substring(0, 250);
    const title = String((body && body.title) || '').trim().substring(0, 250);
    const tokenRaw = body && Object.prototype.hasOwnProperty.call(body, 'token')
        ? String(body.token || '').trim()
        : null;

    let tokenEncrypted = null;
    if (tokenRaw) {
        try {
            tokenEncrypted = ntfy.packToken(tokenRaw);
        } catch (err) {
            return { error: err.message };
        }
    }

    return {
        value: {
            name,
            provider: 'ntfy',
            config: {
                server_url: serverUrl,
                topic,
                priority,
                tags,
                title
            },
            token_encrypted: tokenEncrypted
        }
    };
}

function sanitizeDiscordPayload(body) {
    const name = String((body && body.name) || '').trim();
    if (!name || name.length > 100) {
        return { error: 'name must be 1-100 characters' };
    }

    const username = String((body && body.username) || '').trim().substring(0, 80);
    const webhookRaw = body && Object.prototype.hasOwnProperty.call(body, 'webhook_url')
        ? String(body.webhook_url || '').trim()
        : null;

    let webhookEncrypted = null;
    if (webhookRaw) {
        try {
            webhookEncrypted = discord.packWebhookUrl(webhookRaw);
        } catch (err) {
            return { error: err.message };
        }
    }

    return {
        value: {
            name,
            provider: 'discord',
            config: {
                username
            },
            token_encrypted: webhookEncrypted
        }
    };
}

function parseJsonObject(raw, field) {
    if (!raw) return { value: {} };
    if (typeof raw === 'object' && !Array.isArray(raw)) return { value: raw };
    try {
        const parsed = JSON.parse(String(raw));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { error: `${field} must be a JSON object` };
        }
        return { value: parsed };
    } catch (_err) {
        return { error: `${field} must be valid JSON` };
    }
}

function sanitizeCustomWebhookPayload(body) {
    const name = String((body && body.name) || '').trim();
    if (!name || name.length > 100) {
        return { error: 'name must be 1-100 characters' };
    }

    let webhookUrl;
    let method;
    let headers;
    let secretHeaders;
    try {
        webhookUrl = customWebhook.normalizeUrl(body && body.webhook_url);
        method = customWebhook.normalizeMethod(body && body.method);
        const parsedHeaders = parseJsonObject(body && body.headers_json, 'headers_json');
        if (parsedHeaders.error) return { error: parsedHeaders.error };
        const parsedSecretHeaders = parseJsonObject(body && body.secret_headers_json, 'secret_headers_json');
        if (parsedSecretHeaders.error) return { error: parsedSecretHeaders.error };
        headers = customWebhook.normalizeHeaders(parsedHeaders.value);
        secretHeaders = customWebhook.normalizeHeaders(parsedSecretHeaders.value, { allowAuthorization: true });
    } catch (err) {
        return { error: err.message };
    }

    let tokenEncrypted = null;
    const bearerToken = body && Object.prototype.hasOwnProperty.call(body, 'bearer_token')
        ? String(body.bearer_token || '').trim()
        : '';
    if (bearerToken || Object.keys(secretHeaders).length > 0) {
        try {
            tokenEncrypted = customWebhook.packSecrets({
                bearer_token: bearerToken,
                secret_headers: secretHeaders
            });
        } catch (err) {
            return { error: err.message };
        }
    }

    return {
        value: {
            name,
            provider: 'custom_webhook',
            config: {
                webhook_url: webhookUrl,
                method,
                headers,
                content_type: customWebhook.normalizeContentType(body && body.content_type),
                body_template: customWebhook.normalizeBody(body && body.body_template)
            },
            token_encrypted: tokenEncrypted
        }
    };
}

function sanitizeProviderPayload(provider, body) {
    if (provider === 'discord') {
        return sanitizeDiscordPayload(body);
    }
    if (provider === 'ntfy') {
        return sanitizeNtfyPayload(body);
    }
    if (provider === 'custom_webhook') {
        return sanitizeCustomWebhookPayload(body);
    }
    return { error: 'Unsupported provider' };
}

router.get('/', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 2);
    if (!auth) return;
    const rows = await notificationDB.listByChannel(auth.channelRow.id);
    res.json(rows.map(sanitizeIntegration));
});

router.get('/targets', async (req, res) => {
    const auth = await authorizeChannelRead(req, res, 2);
    if (!auth) return;
    const rows = await notificationDB.listConnectedByChannel(auth.channelRow.id);
    res.json(rows.map(row => ({
        id: String(row.id),
        provider: row.provider,
        name: row.name
    })));
});

router.post('/:provider', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 3);
    if (!auth) return;

    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Unsupported provider' });
    }

    const validated = sanitizeProviderPayload(provider, req.body || {});
    if (validated.error) {
        return res.status(400).json({ error: validated.error });
    }
    if (provider === 'discord' && !validated.value.token_encrypted) {
        return res.status(400).json({ error: 'webhook_url is required' });
    }

    const id = await notificationDB.createIntegration(auth.channelRow.id, {
        ...validated.value,
        connected_by: auth.user.name,
        updated_by: auth.user.name
    });
    const row = await notificationDB.getById(id, auth.channelRow.id);
    res.status(201).json(sanitizeIntegration(row));
});

router.put('/:provider/:id', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 3);
    if (!auth) return;

    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Unsupported provider' });
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid integration id' });
    const existing = await notificationDB.getById(id, auth.channelRow.id);
    if (!existing || existing.provider !== provider) {
        return res.status(404).json({ error: 'Integration not found' });
    }

    const validated = sanitizeProviderPayload(provider, req.body || {});
    if (validated.error) {
        return res.status(400).json({ error: validated.error });
    }

    await notificationDB.updateIntegration(id, auth.channelRow.id, {
        ...validated.value,
        token_encrypted: validated.value.token_encrypted || existing.token_encrypted,
        updated_by: auth.user.name
    });
    const row = await notificationDB.getById(id, auth.channelRow.id);
    res.json(sanitizeIntegration(row));
});

router.delete('/:provider/:id', async (req, res) => {
    const auth = await authorizeChannelAdmin(req, res, 3);
    if (!auth) return;

    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Unsupported provider' });
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid integration id' });
    const existing = await notificationDB.getById(id, auth.channelRow.id);
    if (!existing || existing.provider !== provider) {
        return res.status(404).json({ error: 'Integration not found' });
    }

    await notificationDB.disconnectIntegration(id, auth.channelRow.id, auth.user.name);
    res.json({ success: true });
});

module.exports = router;
