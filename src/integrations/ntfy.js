const http = require('http');
const https = require('https');
const Config = require('../config');
const { encryptString, decryptString } = require('../util/secretbox');

function getEncryptionKey() {
    return process.env.CALENDAR_SYNC_ENCRYPTION_KEY ||
        Config.get('calendar-sync.encryption-key') ||
        '';
}

function normalizeServerUrl(raw) {
    const value = String(raw || 'https://ntfy.sh').trim().replace(/\/+$/g, '');
    if (!/^https?:\/\//i.test(value)) {
        throw new Error('server_url must start with http:// or https://');
    }
    return value;
}

function normalizeTopic(raw) {
    const value = String(raw || '').trim();
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(value)) {
        throw new Error('topic must be 1-64 letters, numbers, underscores, or dashes');
    }
    return value;
}

function packToken(token) {
    const value = String(token || '').trim();
    if (!value) return null;
    const key = getEncryptionKey();
    if (!key) {
        throw new Error('Encryption key is required to store ntfy access tokens');
    }
    return encryptString(value, key);
}

function unpackToken(integration) {
    if (!integration || !integration.token_encrypted) return null;
    const key = getEncryptionKey();
    if (!key) {
        throw new Error('Encryption key is required to read ntfy access tokens');
    }
    return decryptString(integration.token_encrypted, key);
}

function requestText(method, url, body, headers) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'http:' ? http : https;
        const rawBody = body ? Buffer.from(String(body), 'utf8') : Buffer.alloc(0);
        const req = transport.request(parsed, {
            method,
            headers: Object.assign({
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': rawBody.length
            }, headers || {})
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(text);
                    return;
                }

                const err = new Error(text || `HTTP ${res.statusCode}`);
                err.statusCode = res.statusCode;
                reject(err);
            });
        });
        req.on('error', reject);
        if (rawBody.length > 0) {
            req.write(rawBody);
        }
        req.end();
    });
}

async function publish(integration, message, opts = {}) {
    const config = integration.config || {};
    const serverUrl = normalizeServerUrl(config.server_url || 'https://ntfy.sh');
    const topic = normalizeTopic(config.topic);
    const headers = {};
    const title = opts.title || config.title || '';
    const priority = opts.priority || config.priority || '';
    const tags = opts.tags || config.tags || '';
    const click = opts.click || config.click || '';
    const token = unpackToken(integration);

    if (title) headers.Title = String(title).substring(0, 250);
    if (priority) headers.Priority = String(priority);
    if (tags) headers.Tags = String(tags).substring(0, 250);
    if (click) headers.Click = String(click).substring(0, 2048);
    if (token) headers.Authorization = `Bearer ${token}`;

    return requestText('POST', `${serverUrl}/${encodeURIComponent(topic)}`, message, headers);
}

module.exports = {
    normalizeServerUrl,
    normalizeTopic,
    packToken,
    publish
};
