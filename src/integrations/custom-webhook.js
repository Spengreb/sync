const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { encryptString, decryptString } = require('../util/secretbox');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_HEADERS = new Set([
    'connection',
    'content-length',
    'host',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;

function getEncryptionKey() {
    if (process.env.CALENDAR_SYNC_ENCRYPTION_KEY) {
        return process.env.CALENDAR_SYNC_ENCRYPTION_KEY;
    }
    const Config = require('../config');
    return Config.get('calendar-sync.encryption-key') || '';
}

function normalizeMethod(raw) {
    const method = String(raw || 'POST').trim().toUpperCase();
    if (!METHODS.has(method)) {
        throw new Error('method must be GET, POST, PUT, PATCH, or DELETE');
    }
    return method;
}

function normalizeUrl(raw) {
    const value = String(raw || '').trim();
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_err) {
        throw new Error('webhook_url must be a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('webhook_url must start with http:// or https://');
    }
    if (parsed.username || parsed.password) {
        throw new Error('webhook_url must not include username or password');
    }
    return parsed.toString();
}

function normalizeHeaderName(name) {
    const key = String(name || '').trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,80}$/.test(key)) {
        throw new Error('header names must be valid HTTP token strings');
    }
    if (BLOCKED_HEADERS.has(key.toLowerCase())) {
        throw new Error(`${key} header is managed by the server`);
    }
    return key;
}

function normalizeHeaders(raw, opts = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const headers = {};
    Object.keys(source).slice(0, 50).forEach(name => {
        const key = normalizeHeaderName(name);
        if (!opts.allowAuthorization && key.toLowerCase() === 'authorization') {
            throw new Error('Authorization must be configured in the auth section');
        }
        const value = String(source[name] === null || source[name] === undefined ? '' : source[name]);
        if (value.length > 4000) {
            throw new Error(`${key} header is too long`);
        }
        headers[key] = value;
    });
    return headers;
}

function normalizeContentType(raw) {
    return String(raw || 'application/json').trim().substring(0, 200) || 'application/json';
}

function normalizeBody(raw) {
    return String(raw || '').substring(0, MAX_BODY_BYTES);
}

function packSecrets(secrets) {
    const value = {
        bearer_token: String(secrets && secrets.bearer_token || '').trim(),
        secret_headers: normalizeHeaders(secrets && secrets.secret_headers, { allowAuthorization: true })
    };
    if (!value.bearer_token && Object.keys(value.secret_headers).length === 0) {
        return null;
    }

    const key = getEncryptionKey();
    if (!key) {
        throw new Error('Encryption key is required to store custom webhook secrets');
    }
    return encryptString(JSON.stringify(value), key);
}

function unpackSecrets(integration) {
    if (!integration || !integration.token_encrypted) {
        return { bearer_token: '', secret_headers: {} };
    }
    const key = getEncryptionKey();
    if (!key) {
        throw new Error('Encryption key is required to read custom webhook secrets');
    }
    try {
        const parsed = JSON.parse(decryptString(integration.token_encrypted, key));
        return {
            bearer_token: String(parsed && parsed.bearer_token || ''),
            secret_headers: normalizeHeaders(parsed && parsed.secret_headers, { allowAuthorization: true })
        };
    } catch (err) {
        if (err && err.message && err.message.indexOf('header') !== -1) {
            throw err;
        }
        throw new Error('Custom webhook secrets payload is invalid');
    }
}

function renderTemplate(template, context) {
    const replacements = context && context.replacements || {};
    return String(template || '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(replacements, key)
            ? String(replacements[key])
            : match;
    });
}

function withJsonEscapes(replacements) {
    const output = Object.assign({}, replacements || {});
    Object.keys(replacements || {}).forEach(key => {
        output[`${key}_json`] = JSON.stringify(String(replacements[key])).slice(1, -1);
    });
    return output;
}

function buildTemplateReplacements(message, context = {}) {
    return withJsonEscapes(Object.assign({}, context.replacements || {}, {
        message: String(message || ''),
        notification_message: String(message || '')
    }));
}

function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const parts = address.split('.').map(part => parseInt(part, 10));
        return parts[0] === 10 ||
            parts[0] === 127 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            parts[0] === 0;
    }
    if (net.isIPv6(address)) {
        const normalized = address.toLowerCase();
        if (normalized.startsWith('::ffff:')) {
            return isPrivateAddress(normalized.slice(7));
        }
        return normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            normalized.startsWith('fe80:') ||
            normalized === '::';
    }
    return true;
}

function assertPublicHostname(hostname) {
    const lower = String(hostname || '').toLowerCase();
    if (!lower || lower === 'localhost' || lower.endsWith('.localhost')) {
        throw new Error('webhook_url must not target localhost');
    }
    if (net.isIP(lower) && isPrivateAddress(lower)) {
        throw new Error('webhook_url must not target private network addresses');
    }
}

async function assertPublicDestination(parsed) {
    assertPublicHostname(parsed.hostname);
    const records = await dns.promises.lookup(parsed.hostname, { all: true });
    if (!records.length || records.some(record => isPrivateAddress(record.address))) {
        throw new Error('webhook_url must resolve to public network addresses');
    }
}

function request(method, rawUrl, body, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(rawUrl);
        const transport = parsed.protocol === 'http:' ? http : https;
        const rawBody = body ? Buffer.from(String(body), 'utf8') : Buffer.alloc(0);
        if (rawBody.length > MAX_BODY_BYTES) {
            reject(new Error('Custom webhook body is too large'));
            return;
        }

        const req = transport.request(parsed, {
            method,
            headers: Object.assign({}, headers, {
                'Content-Length': rawBody.length
            }),
            timeout: timeoutMs
        }, res => {
            const chunks = [];
            let total = 0;
            res.on('data', chunk => {
                total += chunk.length;
                if (total <= MAX_RESPONSE_BYTES) {
                    chunks.push(chunk);
                }
            });
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
        req.on('timeout', () => {
            req.destroy(new Error('Custom webhook request timed out'));
        });
        req.on('error', reject);
        if (rawBody.length > 0) {
            req.write(rawBody);
        }
        req.end();
    });
}

async function publish(integration, message, context = {}) {
    const config = integration.config || {};
    const url = normalizeUrl(config.webhook_url);
    const parsed = new URL(url);
    await assertPublicDestination(parsed);

    const method = normalizeMethod(config.method);
    const contentType = normalizeContentType(config.content_type);
    const secrets = unpackSecrets(integration);
    const headers = Object.assign({}, normalizeHeaders(config.headers));
    const bodyTemplate = config.body_template || JSON.stringify({
        event: 'show_notification',
        message: '{notification_message_json}',
        show_name: '{show_name_json}',
        channel_name: '{channel_name_json}',
        show_url: '{show_url_json}'
    });
    const replacements = buildTemplateReplacements(message, context);
    const body = method === 'GET'
        ? ''
        : renderTemplate(bodyTemplate, { replacements });

    Object.keys(secrets.secret_headers).forEach(key => {
        headers[key] = renderTemplate(secrets.secret_headers[key], { replacements });
    });
    if (secrets.bearer_token) {
        headers.Authorization = `Bearer ${renderTemplate(secrets.bearer_token, { replacements })}`;
    }
    if (body && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = contentType;
    }

    return request(method, url, body, headers, DEFAULT_TIMEOUT_MS);
}

module.exports = {
    normalizeMethod,
    normalizeUrl,
    normalizeHeaders,
    normalizeContentType,
    normalizeBody,
    packSecrets,
    buildTemplateReplacements,
    publish,
    renderTemplate,
    isPrivateAddress
};
