const https = require('https');
const querystring = require('querystring');
const Config = require('../config');
const { encryptString, decryptString } = require('../util/secretbox');

function getIntegrationConfig() {
    return Config.get('calendar-sync');
}

function isEnabled() {
    const cfg = getIntegrationConfig();
    return !!cfg.enabled;
}

function getEncryptionKey() {
    return process.env.CALENDAR_SYNC_ENCRYPTION_KEY ||
        Config.get('calendar-sync.encryption-key') ||
        '';
}

function getGoogleConfig() {
    return Config.get('calendar-sync.google');
}

function assertConfigured() {
    if (!isEnabled()) {
        throw new Error('Calendar sync is disabled by config');
    }
    const google = getGoogleConfig();
    if (!google['client-id'] || !google['client-secret'] || !google['redirect-uri']) {
        throw new Error('Google calendar sync config is incomplete');
    }
    if (!getEncryptionKey()) {
        throw new Error('Calendar sync encryption key is not configured');
    }
}

function encodeState(payload, cookieSecret) {
    const crypto = require('crypto');
    const raw = Buffer.from(JSON.stringify(payload)).toString('base64');
    const sig = crypto.createHmac('sha256', cookieSecret).update(raw).digest('hex');
    return `${raw}.${sig}`;
}

function decodeState(state, cookieSecret) {
    const crypto = require('crypto');
    if (!state || typeof state !== 'string' || state.indexOf('.') === -1) {
        throw new Error('Invalid OAuth state');
    }
    const parts = state.split('.');
    const raw = parts[0];
    const sig = parts[1];
    const expected = crypto.createHmac('sha256', cookieSecret).update(raw).digest('hex');
    if (sig !== expected) {
        throw new Error('Invalid OAuth state signature');
    }
    const payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!payload || payload.exp < Date.now()) {
        throw new Error('OAuth state expired');
    }
    return payload;
}

function buildAuthUrl(state) {
    assertConfigured();
    const google = getGoogleConfig();
    const qs = querystring.stringify({
        client_id: google['client-id'],
        redirect_uri: google['redirect-uri'],
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.events',
        access_type: 'offline',
        prompt: 'consent',
        state
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${qs}`;
}

function requestJson(method, baseUrl, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const rawBody = body ? JSON.stringify(body) : null;
        const req = https.request(baseUrl + path, {
            method,
            headers: Object.assign(
                {
                    Accept: 'application/json'
                },
                rawBody ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(rawBody)
                } : {},
                headers
            )
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                let parsed = {};
                try {
                    parsed = text ? JSON.parse(text) : {};
                } catch (_err) {
                    if (!ok) {
                        return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
                    }
                    parsed = {};
                }
                if (!ok) {
                    let message = parsed.error_description || parsed.error || `HTTP ${res.statusCode}`;
                    if (message && typeof message === 'object') {
                        message = message.message || message.status || JSON.stringify(message);
                    }
                    return reject(new Error(String(message)));
                }
                resolve(parsed);
            });
        });
        req.on('error', reject);
        if (rawBody) req.write(rawBody);
        req.end();
    });
}

function requestForm(baseUrl, path, formBody) {
    return new Promise((resolve, reject) => {
        const raw = querystring.stringify(formBody);
        const req = https.request(baseUrl + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(raw),
                Accept: 'application/json'
            }
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                let parsed = {};
                try {
                    parsed = text ? JSON.parse(text) : {};
                } catch (_err) {
                    return reject(new Error(`Google token parse error: ${text}`));
                }
                if (!ok) {
                    let message = parsed.error_description || parsed.error || `HTTP ${res.statusCode}`;
                    if (message && typeof message === 'object') {
                        message = message.message || message.status || JSON.stringify(message);
                    }
                    return reject(new Error(String(message)));
                }
                resolve(parsed);
            });
        });
        req.on('error', reject);
        req.write(raw);
        req.end();
    });
}

async function exchangeCodeForToken(code) {
    assertConfigured();
    const google = getGoogleConfig();
    return requestForm('https://oauth2.googleapis.com', '/token', {
        code,
        client_id: google['client-id'],
        client_secret: google['client-secret'],
        redirect_uri: google['redirect-uri'],
        grant_type: 'authorization_code'
    });
}

async function refreshAccessToken(refreshToken) {
    assertConfigured();
    const google = getGoogleConfig();
    return requestForm('https://oauth2.googleapis.com', '/token', {
        refresh_token: refreshToken,
        client_id: google['client-id'],
        client_secret: google['client-secret'],
        grant_type: 'refresh_token'
    });
}

function packTokens(tokenPayload) {
    const key = getEncryptionKey();
    const expiresAt = Date.now() + ((tokenPayload.expires_in || 3600) * 1000);
    return {
        token_encrypted: encryptString(tokenPayload.access_token, key),
        refresh_token_encrypted: tokenPayload.refresh_token ?
            encryptString(tokenPayload.refresh_token, key) : null,
        token_expires_at: expiresAt
    };
}

function unpackTokens(integrationRow) {
    const key = getEncryptionKey();
    return {
        accessToken: integrationRow.token_encrypted ? decryptString(integrationRow.token_encrypted, key) : null,
        refreshToken: integrationRow.refresh_token_encrypted ? decryptString(integrationRow.refresh_token_encrypted, key) : null,
        tokenExpiresAt: integrationRow.token_expires_at || 0
    };
}

async function upsertGoogleCalendarEvent(accessToken, calendarId, show) {
    const start = new Date(show.scheduled_for);
    const endMs = Number(show.estimated_end_at || 0);
    const end = new Date(endMs > start.getTime() ? endMs : (start.getTime() + 60 * 60 * 1000));
    const body = {
        summary: show.name,
        description: show.notes || '',
        start: {
            dateTime: start.toISOString(),
            timeZone: show.timezone || 'UTC'
        },
        end: {
            dateTime: end.toISOString(),
            timeZone: show.timezone || 'UTC'
        },
        colorId: null
    };
    return requestJson(
        'POST',
        'https://www.googleapis.com',
        `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        body,
        { Authorization: `Bearer ${accessToken}` }
    );
}

async function updateGoogleCalendarEvent(accessToken, calendarId, eventId, show) {
    const start = new Date(show.scheduled_for);
    const endMs = Number(show.estimated_end_at || 0);
    const end = new Date(endMs > start.getTime() ? endMs : (start.getTime() + 60 * 60 * 1000));
    const body = {
        summary: show.name,
        description: show.notes || '',
        start: {
            dateTime: start.toISOString(),
            timeZone: show.timezone || 'UTC'
        },
        end: {
            dateTime: end.toISOString(),
            timeZone: show.timezone || 'UTC'
        }
    };
    return requestJson(
        'PUT',
        'https://www.googleapis.com',
        `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        body,
        { Authorization: `Bearer ${accessToken}` }
    );
}

module.exports = {
    isEnabled,
    assertConfigured,
    encodeState,
    decodeState,
    buildAuthUrl,
    exchangeCodeForToken,
    refreshAccessToken,
    packTokens,
    unpackTokens,
    upsertGoogleCalendarEvent,
    updateGoogleCalendarEvent
};
