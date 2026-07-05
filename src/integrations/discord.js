const https = require('https');
const Config = require('../config');
const { encryptString, decryptString } = require('../util/secretbox');

function getEncryptionKey() {
    return process.env.CALENDAR_SYNC_ENCRYPTION_KEY ||
        Config.get('calendar-sync.encryption-key') ||
        '';
}

function normalizeWebhookUrl(raw) {
    const value = String(raw || '').trim();
    if (!/^https:\/\/((canary|ptb)\.)?(discord(app)?\.com)\/api\/webhooks\/\d+\/[-_A-Za-z0-9]+\/?([?#].*)?$/i.test(value)) {
        throw new Error('webhook_url must be a Discord webhook URL');
    }
    return value.replace(/[?#].*$/g, '').replace(/\/$/g, '');
}

function packWebhookUrl(webhookUrl) {
    const value = normalizeWebhookUrl(webhookUrl);
    const key = getEncryptionKey();
    if (!key) {
        throw new Error('Encryption key is required to store Discord webhook URLs');
    }
    return encryptString(value, key);
}

function unpackWebhookUrl(integration) {
    if (!integration || !integration.token_encrypted) {
        throw new Error('Discord webhook URL is not configured');
    }
    const key = getEncryptionKey();
    if (!key) {
        throw new Error('Encryption key is required to read Discord webhook URLs');
    }
    return decryptString(integration.token_encrypted, key);
}

function requestJson(method, url, body) {
    return new Promise((resolve, reject) => {
        const rawBody = JSON.stringify(body || {});
        const req = https.request(url, {
            method,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(rawBody)
            }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(text ? JSON.parse(text) : {});
                    return;
                }

                let message = text || `HTTP ${res.statusCode}`;
                try {
                    const parsed = JSON.parse(text);
                    message = parsed.message || parsed.error || message;
                } catch (_err) {
                    // Keep raw text.
                }
                const err = new Error(String(message));
                err.statusCode = res.statusCode;
                reject(err);
            });
        });
        req.on('error', reject);
        req.write(rawBody);
        req.end();
    });
}

async function publish(integration, message) {
    const config = integration.config || {};
    const webhookUrl = unpackWebhookUrl(integration);
    const url = webhookUrl + (webhookUrl.indexOf('?') === -1 ? '?wait=true' : '&wait=true');
    const body = {
        content: String(message || '').substring(0, 2000),
        allowed_mentions: {
            parse: []
        }
    };
    if (config.username) {
        body.username = String(config.username).substring(0, 80);
    }
    return requestJson('POST', url, body);
}

module.exports = {
    normalizeWebhookUrl,
    packWebhookUrl,
    publish
};
