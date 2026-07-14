const crypto = require('crypto');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
const Config = require('../config');
const db = require('../database');
const session = require('../session');
const webserver = require('./webserver');
const { sendPug } = require('./pug');
const csrf = require('./csrf');

const LOGGER = require('@calzoneman/jsli')('web/oidc');
const discoveryCache = new Map();
const jwksCache = new Map();
const PENDING_COOKIE = 'oidc_pending';

function base64url(input) {
    return Buffer.from(input).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function sha256base64url(input) {
    return crypto.createHash('sha256').update(input).digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function unbase64url(input) {
    input = String(input).replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4 !== 0) input += '=';
    return Buffer.from(input, 'base64');
}

function signState(payload) {
    const body = base64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', Config.get('http.cookie-secret'))
        .update(body)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return `${body}.${sig}`;
}

function verifyState(state) {
    if (typeof state !== 'string' || state.indexOf('.') === -1) {
        throw new Error('Invalid OIDC state');
    }

    const [body, sig] = state.split('.');
    const expected = crypto.createHmac('sha256', Config.get('http.cookie-secret'))
        .update(body)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    if (sig.length !== expected.length ||
            !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        throw new Error('Invalid OIDC state signature');
    }

    const payload = JSON.parse(unbase64url(body).toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) {
        throw new Error('OIDC state expired');
    }
    return payload;
}

function request(method, rawUrl, body, headers) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(rawUrl);
        const transport = parsed.protocol === 'http:' ? http : https;
        const rawBody = body ? Buffer.from(String(body), 'utf8') : Buffer.alloc(0);
        const req = transport.request(parsed, {
            method,
            headers: Object.assign({
                Accept: 'application/json',
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
                const error = new Error(text || `HTTP ${res.statusCode}`);
                error.statusCode = res.statusCode;
                reject(error);
            });
        });
        req.on('error', reject);
        if (rawBody.length > 0) req.write(rawBody);
        req.end();
    });
}

async function requestJson(method, rawUrl, body, headers) {
    const text = await request(method, rawUrl, body, headers);
    return text ? JSON.parse(text) : {};
}

async function discover(provider) {
    const cached = discoveryCache.get(provider.id);
    if (cached && cached.expires > Date.now()) {
        return cached.metadata;
    }

    const metadata = await requestJson(
        'GET',
        `${provider.issuer_url.replace(/\/+$/g, '')}/.well-known/openid-configuration`
    );
    if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
        throw new Error('OIDC discovery document is missing required endpoints');
    }
    discoveryCache.set(provider.id, {
        metadata,
        expires: Date.now() + 3600000
    });
    return metadata;
}

async function getJwks(provider, metadata) {
    const cached = jwksCache.get(provider.id);
    if (cached && cached.expires > Date.now()) {
        return cached.keys;
    }

    const jwks = await requestJson('GET', metadata.jwks_uri);
    if (!jwks.keys || !Array.isArray(jwks.keys)) {
        throw new Error('OIDC JWKS response is invalid');
    }
    jwksCache.set(provider.id, {
        keys: jwks.keys,
        expires: Date.now() + 3600000
    });
    return jwks.keys;
}

function ecdsaJoseToDer(signature) {
    const half = signature.length / 2;
    function trimInteger(buf) {
        let out = buf;
        while (out.length > 1 && out[0] === 0) out = out.slice(1);
        if (out[0] & 0x80) out = Buffer.concat([Buffer.from([0]), out]);
        return out;
    }
    const r = trimInteger(signature.slice(0, half));
    const s = trimInteger(signature.slice(half));
    const total = 2 + r.length + 2 + s.length;
    return Buffer.concat([
        Buffer.from([0x30, total, 0x02, r.length]),
        r,
        Buffer.from([0x02, s.length]),
        s
    ]);
}

async function validateIdToken(provider, metadata, idToken, expected) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid ID token');
    }

    const header = JSON.parse(unbase64url(parts[0]).toString('utf8'));
    const claims = JSON.parse(unbase64url(parts[1]).toString('utf8'));
    const keys = await getJwks(provider, metadata);
    const jwk = keys.find(key => key.kid === header.kid) || keys.find(key => key.kty);
    if (!jwk) {
        throw new Error('No matching OIDC signing key found');
    }

    const verifier = crypto.createVerify(header.alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();

    let signature = unbase64url(parts[2]);
    if (header.alg === 'ES256') {
        signature = ecdsaJoseToDer(signature);
    } else if (header.alg !== 'RS256') {
        throw new Error(`Unsupported ID token signing algorithm ${header.alg}`);
    }

    if (!verifier.verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), signature)) {
        throw new Error('Invalid ID token signature');
    }

    const issuer = metadata.issuer || provider.issuer_url;
    if (claims.iss !== issuer) {
        throw new Error('ID token issuer mismatch');
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(provider.client_id)) {
        throw new Error('ID token audience mismatch');
    }
    if (claims.exp * 1000 <= Date.now()) {
        throw new Error('ID token expired');
    }
    if (claims.nonce !== expected.nonce) {
        throw new Error('ID token nonce mismatch');
    }
    if (!claims.sub) {
        throw new Error('ID token is missing subject');
    }

    return claims;
}

function getBaseUrl(req) {
    return `${req.realProtocol}://${req.header('host')}`;
}

function getRedirectUri(req, providerId) {
    return `${getBaseUrl(req)}/login/oidc/${providerId}/callback`;
}

function getPkceCookieName(providerId) {
    return `oidc_pkce_${providerId}`;
}

function getOidcCookieOptions(req) {
    return {
        expires: new Date(Date.now() + 10 * 60 * 1000),
        httpOnly: true,
        signed: true,
        sameSite: 'lax',
        secure: req.realProtocol === 'https' || req.secure === true
    };
}

function setPendingIdentity(req, res, provider, claims, dest) {
    const pending = {
        provider_id: provider.id,
        provider_display_name: provider.display_name,
        allow_auto_provision: !!provider.allow_auto_provision,
        suggested_username: db.oidc.suggestUsername(provider, claims),
        dest,
        exp: Date.now() + 15 * 60 * 1000,
        claims: {
            iss: claims.iss,
            sub: claims.sub,
            email: claims.email || '',
            preferred_username: claims.preferred_username || '',
            [provider.username_claim]: claims[provider.username_claim] || ''
        }
    };

    res.cookie(PENDING_COOKIE, JSON.stringify(pending), getOidcCookieOptions(req));
}

function clearPendingIdentity(res) {
    res.clearCookie(PENDING_COOKIE);
}

function getPendingIdentity(req) {
    if (!req.signedCookies || !req.signedCookies[PENDING_COOKIE]) {
        throw new Error('OIDC login session expired. Please try again.');
    }

    const pending = JSON.parse(req.signedCookies[PENDING_COOKIE]);
    if (!pending.exp || Date.now() > pending.exp) {
        throw new Error('OIDC login session expired. Please try again.');
    }
    return pending;
}

function safeDestination(req, dest) {
    if (typeof dest !== 'string' || !dest || /login|logout/.test(dest)) {
        return null;
    }

    if (dest[0] === '/' && dest[1] !== '/') {
        return dest;
    }

    try {
        const parsed = new URL(dest);
        if (parsed.hostname === req.hostname) {
            return dest;
        }
    } catch (_error) {
        return null;
    }

    return null;
}

async function startOidc(req, res, intent) {
    const provider = await db.oidc.getEnabledProvider(req.params.provider);
    if (!provider) {
        res.status(404);
        return sendPug(res, 'httperror', {
            path: req.path,
            status: 404,
            message: 'OIDC provider is not configured'
        });
    }

    const metadata = await discover(provider);
    const nonce = base64url(crypto.randomBytes(24));
    const codeVerifier = base64url(crypto.randomBytes(32));
    const state = signState({
        provider: provider.id,
        intent,
        nonce,
        dest: safeDestination(req, req.query.dest),
        exp: Date.now() + 10 * 60 * 1000
    });
    res.cookie(getPkceCookieName(provider.id), codeVerifier, getOidcCookieOptions(req));
    const redirect = new URL(metadata.authorization_endpoint);
    redirect.searchParams.set('client_id', provider.client_id);
    redirect.searchParams.set('redirect_uri', getRedirectUri(req, provider.id));
    redirect.searchParams.set('response_type', 'code');
    redirect.searchParams.set('scope', provider.scopes);
    redirect.searchParams.set('state', state);
    redirect.searchParams.set('nonce', nonce);
    redirect.searchParams.set('code_challenge', sha256base64url(codeVerifier));
    redirect.searchParams.set('code_challenge_method', 'S256');
    res.redirect(redirect.toString());
}

async function exchangeCode(req, provider, metadata, code, codeVerifier) {
    const body = querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRedirectUri(req, provider.id),
        client_id: provider.client_id,
        code_verifier: codeVerifier
    });
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };
    if (provider.client_secret) {
        const auth = Buffer.from(`${provider.client_id}:${provider.client_secret}`).toString('base64');
        headers.Authorization = `Basic ${auth}`;
    }
    return requestJson('POST', metadata.token_endpoint, body, headers);
}

function issueSession(req, res, user, dest) {
    return new Promise((resolve, reject) => {
        const expiration = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        session.genSession(user, expiration, (err, auth) => {
            if (err) {
                reject(err);
                return;
            }

            webserver.setAuthCookie(req, res, expiration, auth);
            res.redirect(dest || '/login');
            resolve();
        });
    });
}

async function handleCallback(req, res) {
    try {
        if (req.query.error) {
            throw new Error(`OIDC provider returned ${req.query.error}`);
        }

        const state = verifyState(req.query.state);
        if (state.provider !== req.params.provider) {
            throw new Error('OIDC state provider mismatch');
        }
        const pkceCookieName = getPkceCookieName(state.provider);
        const codeVerifier = req.signedCookies && req.signedCookies[pkceCookieName];
        res.clearCookie(pkceCookieName);
        if (!codeVerifier) {
            throw new Error('OIDC PKCE verifier cookie is missing or expired');
        }

        const provider = await db.oidc.getEnabledProvider(state.provider);
        if (!provider) {
            throw new Error('OIDC provider is no longer enabled');
        }

        const metadata = await discover(provider);
        const token = await exchangeCode(req, provider, metadata, req.query.code, codeVerifier);
        const claims = await validateIdToken(provider, metadata, token.id_token, state);
        const identity = await db.oidc.findIdentity(provider.id, claims.iss, claims.sub);

        if (identity) {
            const user = await db.oidc.getUserById(identity.user_id);
            if (!user) {
                throw new Error('Linked Veretube account does not exist');
            }
            return issueSession(req, res, user, state.dest);
        }

        setPendingIdentity(req, res, provider, claims, state.dest);
        return res.redirect(`/login/oidc/${provider.id}/complete`);
    } catch (error) {
        LOGGER.warn('OIDC callback failed: %s', error.stack || error);
        sendPug(res, 'login', {
            loggedIn: false,
            loginError: error.message
        });
    }
}

async function handleComplete(req, res) {
    try {
        const pending = getPendingIdentity(req);
        if (pending.provider_id !== req.params.provider) {
            throw new Error('OIDC login session provider mismatch');
        }

        sendPug(res, 'oidc-complete', {
            pending,
            createUsername: pending.suggested_username
        });
    } catch (error) {
        sendPug(res, 'login', {
            loggedIn: false,
            loginError: error.message
        });
    }
}

function verifyLocalLogin(name, password) {
    return new Promise((resolve, reject) => {
        db.users.verifyLogin(name, password, (err, user) => {
            if (err) {
                reject(new Error(err));
                return;
            }
            resolve(user);
        });
    });
}

async function handleCompletePost(req, res) {
    csrf.verify(req);

    let pending;
    try {
        pending = getPendingIdentity(req);
        if (pending.provider_id !== req.params.provider) {
            throw new Error('OIDC login session provider mismatch');
        }

        const provider = await db.oidc.getEnabledProvider(pending.provider_id);
        if (!provider) {
            throw new Error('OIDC provider is no longer enabled');
        }

        const existing = await db.oidc.findIdentity(
            provider.id,
            pending.claims.iss,
            pending.claims.sub
        );
        if (existing) {
            const user = await db.oidc.getUserById(existing.user_id);
            if (!user) {
                throw new Error('Linked Veretube account does not exist');
            }
            clearPendingIdentity(res);
            return issueSession(req, res, user, pending.dest);
        }

        let user;
        if (req.body.action === 'create') {
            if (!provider.allow_auto_provision) {
                throw new Error('Creating Veretube accounts from this OIDC provider is disabled');
            }
            user = await db.oidc.createUserForIdentity(
                provider,
                pending.claims,
                req.realIP,
                req.body.username
            );
        } else if (req.body.action === 'link_existing') {
            user = await verifyLocalLogin(req.body.name, req.body.password);
            await db.oidc.linkIdentity(user.id, provider.id, pending.claims);
        } else {
            throw new Error('Invalid OIDC completion action');
        }

        clearPendingIdentity(res);
        return issueSession(req, res, user, pending.dest);
    } catch (error) {
        sendPug(res, 'oidc-complete', {
            pending,
            createUsername: req.body.username || (pending && pending.suggested_username),
            errorMessage: error.message
        });
    }
}

module.exports = {
    init: function init(app) {
        app.get('/login/oidc/:provider', (req, res) => startOidc(req, res, 'login'));
        app.get('/login/oidc/:provider/callback', handleCallback);
        app.get('/login/oidc/:provider/complete', handleComplete);
        app.post('/login/oidc/:provider/complete', handleCompletePost);
    },
    discover
};
