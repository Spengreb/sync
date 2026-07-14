const bcrypt = require('bcrypt');
const crypto = require('crypto');
const Config = require('../config');
const db = require('../database');
const $util = require('../utilities');
const { encryptString, decryptString } = require('../util/secretbox');

function getEncryptionKey() {
    return process.env.OIDC_ENCRYPTION_KEY ||
        Config.get('oidc.encryption-key') ||
        '';
}

function validateProviderId(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new Error('Provider ID must be 1-64 letters, numbers, underscores, or dashes');
    }
    return id;
}

function normalizeProviderInput(data, existing) {
    const provider = {
        id: validateProviderId(String(data.id || '').trim()),
        display_name: String(data.display_name || '').trim().substring(0, 100),
        enabled: !!data.enabled,
        issuer_url: String(data.issuer_url || '').trim().replace(/\/+$/g, ''),
        client_id: String(data.client_id || '').trim().substring(0, 255),
        scopes: String(data.scopes || 'openid profile email').trim().substring(0, 255),
        allow_auto_provision: !!data.allow_auto_provision,
        username_claim: String(data.username_claim || 'preferred_username').trim().substring(0, 64)
    };

    if (!provider.display_name) {
        provider.display_name = provider.id;
    }

    if (!/^https?:\/\//i.test(provider.issuer_url)) {
        throw new Error('Issuer URL must start with http:// or https://');
    }

    if (!provider.client_id) {
        throw new Error('Client ID is required');
    }

    if (!/\bopenid\b/.test(provider.scopes)) {
        provider.scopes = `openid ${provider.scopes}`.trim();
    }

    if (!/^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/.test(provider.username_claim)) {
        throw new Error('Username claim is invalid');
    }

    if (typeof data.client_secret === 'string' && data.client_secret.length > 0) {
        const key = getEncryptionKey();
        if (!key) {
            throw new Error('OIDC encryption key is required to store client secrets');
        }
        provider.client_secret_encrypted = encryptString(data.client_secret, key);
    } else if (existing) {
        provider.client_secret_encrypted = existing.client_secret_encrypted;
    } else {
        provider.client_secret_encrypted = null;
    }

    return provider;
}

function publicProvider(row) {
    return {
        id: row.id,
        display_name: row.display_name,
        enabled: !!row.enabled,
        issuer_url: row.issuer_url,
        client_id: row.client_id,
        scopes: row.scopes,
        allow_auto_provision: !!row.allow_auto_provision,
        username_claim: row.username_claim,
        client_secret_configured: !!row.client_secret_encrypted,
        source: row.source || 'acp',
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function providerWithSecret(row) {
    const provider = publicProvider(row);
    provider.client_secret = '';
    if (row.client_secret_encrypted) {
        const key = getEncryptionKey();
        if (!key) {
            throw new Error('OIDC encryption key is required to read client secrets');
        }
        provider.client_secret = decryptString(row.client_secret_encrypted, key);
    }
    return provider;
}

function getConfigProviders() {
    const configured = Config.get('oidc.providers') || [];
    const providers = Array.isArray(configured) ?
        configured :
        Object.keys(configured).map(id => Object.assign({ id }, configured[id]));

    return providers.map(raw => {
        const provider = {
            id: validateProviderId(String(raw.id || '').trim()),
            display_name: String(raw.display_name || raw['display-name'] || raw.name || raw.id || '').trim(),
            enabled: !!raw.enabled,
            issuer_url: String(raw.issuer_url || raw['issuer-url'] || '').trim().replace(/\/+$/g, ''),
            client_id: String(raw.client_id || raw['client-id'] || '').trim(),
            client_secret: String(raw.client_secret || raw['client-secret'] || ''),
            scopes: String(raw.scopes || 'openid profile email').trim(),
            allow_auto_provision: !!(raw.allow_auto_provision || raw['allow-auto-provision']),
            username_claim: String(raw.username_claim || raw['username-claim'] || 'preferred_username').trim(),
            source: 'config'
        };

        if (!provider.display_name) provider.display_name = provider.id;
        if (!provider.issuer_url || !/^https?:\/\//i.test(provider.issuer_url)) {
            throw new Error(`OIDC provider ${provider.id} has invalid issuer-url`);
        }
        if (!provider.client_id) {
            throw new Error(`OIDC provider ${provider.id} is missing client-id`);
        }
        if (!/\bopenid\b/.test(provider.scopes)) {
            provider.scopes = `openid ${provider.scopes}`.trim();
        }
        provider.client_secret_configured = !!provider.client_secret;
        return provider;
    });
}

function getConfigProvider(id) {
    return getConfigProviders().find(provider => provider.id === id) || null;
}

function sanitizeUsername(raw, fallback) {
    let name = String(raw || fallback || 'oidcuser')
        .normalize('NFKD')
        .replace(/[^\w-]/g, '')
        .substring(0, 20);

    if (!name) name = 'oidcuser';
    if (/^[0-9_-]/.test(name)) name = `u${name}`.substring(0, 20);
    return name;
}

function getClaimUsername(provider, claims) {
    return sanitizeUsername(
        claims[provider.username_claim] ||
        claims.preferred_username ||
        (claims.email ? String(claims.email).split('@')[0] : '') ||
        claims.sub,
        'oidcuser'
    );
}

async function chooseAvailableUsername(base, tx) {
    const root = sanitizeUsername(base, 'oidcuser').substring(0, 16);
    for (let i = 0; i < 100; i++) {
        const suffix = i === 0 ? '' : String(i);
        const candidate = `${root}${suffix}`.substring(0, 20);
        if (!$util.isValidUserName(candidate)) continue;
        const nameDedupe = require('./accounts').dedupeUsername(candidate);
        const existing = await tx.table('users')
            .where({ name: candidate })
            .orWhere({ name_dedupe: nameDedupe })
            .first();
        if (!existing) return candidate;
    }

    return `oidc${crypto.randomBytes(8).toString('hex')}`.substring(0, 20);
}

module.exports = {
    listProviders: async function listProviders() {
        const rows = await db.getDB().knex.table('oidc_providers').orderBy('display_name');
        return getConfigProviders()
            .map(provider => Object.assign({}, provider, {
                client_secret: undefined
            }))
            .concat(rows.map(publicProvider));
    },

    listEnabledProviders: async function listEnabledProviders() {
        const rows = await db.getDB().knex.table('oidc_providers')
            .where({ enabled: true })
            .orderBy('display_name');
        return getConfigProviders()
            .filter(provider => provider.enabled)
            .map(provider => Object.assign({}, provider, {
                client_secret: undefined
            }))
            .concat(rows.map(publicProvider));
    },

    getEnabledProvider: async function getEnabledProvider(id) {
        validateProviderId(id);
        const configProvider = getConfigProvider(id);
        if (configProvider && configProvider.enabled) {
            return configProvider;
        }

        const row = await db.getDB().knex.table('oidc_providers')
            .where({ id, enabled: true })
            .first();
        return row ? providerWithSecret(row) : null;
    },

    getProvider: async function getProvider(id) {
        validateProviderId(id);
        const configProvider = getConfigProvider(id);
        if (configProvider) {
            return Object.assign({}, configProvider, {
                client_secret: undefined
            });
        }

        const row = await db.getDB().knex.table('oidc_providers').where({ id }).first();
        return row ? publicProvider(row) : null;
    },

    saveProvider: async function saveProvider(data) {
        const knex = db.getDB().knex;
        const id = validateProviderId(String(data.id || '').trim());
        if (getConfigProvider(id)) {
            throw new Error(`OIDC provider ${id} is configured in config.yaml`);
        }
        const existing = await knex.table('oidc_providers').where({ id }).first();
        const provider = normalizeProviderInput(data, existing);

        if (existing) {
            await knex.table('oidc_providers').where({ id }).update(provider);
        } else {
            await knex.table('oidc_providers').insert(provider);
        }

        return module.exports.getProvider(id);
    },

    deleteProvider: async function deleteProvider(id) {
        validateProviderId(id);
        if (getConfigProvider(id)) {
            throw new Error(`OIDC provider ${id} is configured in config.yaml`);
        }
        await db.getDB().knex.table('oidc_providers').where({ id }).delete();
    },

    findIdentity: async function findIdentity(providerId, issuer, subject) {
        return db.getDB().knex.table('user_oidc_identities')
            .where({ provider_id: providerId, issuer, subject })
            .first();
    },

    listIdentitiesForUser: async function listIdentitiesForUser(userId) {
        return db.getDB().knex.table('user_oidc_identities')
            .leftJoin('oidc_providers', 'user_oidc_identities.provider_id', 'oidc_providers.id')
            .where('user_oidc_identities.user_id', userId)
            .select(
                'user_oidc_identities.*',
                'oidc_providers.display_name as provider_display_name'
            )
            .orderBy('user_oidc_identities.created_at', 'desc');
    },

    linkIdentity: async function linkIdentity(userId, providerId, claims) {
        const now = new Date();
        await db.getDB().knex.table('user_oidc_identities').insert({
            user_id: userId,
            provider_id: providerId,
            issuer: claims.iss,
            subject: claims.sub,
            email: claims.email || null,
            preferred_username: claims.preferred_username || null,
            created_at: now,
            updated_at: now
        });
    },

    unlinkIdentity: async function unlinkIdentity(userId, id) {
        await db.getDB().knex.table('user_oidc_identities')
            .where({ user_id: userId, id })
            .delete();
    },

    suggestUsername: function suggestUsername(provider, claims) {
        return getClaimUsername(provider, claims);
    },

    getUserById: async function getUserById(id) {
        const row = await db.getDB().knex.table('users')
            .where({ id, inactive: false })
            .first();
        if (!row) return null;
        try {
            row.profile = JSON.parse(row.profile || '{}');
        } catch (_error) {
            row.profile = { image: '', text: '' };
        }
        return row;
    },

    createUserForIdentity: async function createUserForIdentity(provider, claims, ip, requestedName) {
        return db.getDB().runTransaction(async tx => {
            let name;
            if (requestedName) {
                name = String(requestedName).trim();
                if (!$util.isValidUserName(name)) {
                    throw new Error(
                        "Invalid username.  Usernames may consist of 1-20 " +
                        "characters a-z, A-Z, 0-9, -, _, and accented letters."
                    );
                }

                const nameDedupe = require('./accounts').dedupeUsername(name);
                const existing = await tx.table('users')
                    .where({ name })
                    .orWhere({ name_dedupe: nameDedupe })
                    .first();
                if (existing) {
                    throw new Error(`Username "${name}" is already registered or too similar to an existing name`);
                }
            } else {
                name = await chooseAvailableUsername(getClaimUsername(provider, claims), tx);
            }

            const existingIdentity = await tx.table('user_oidc_identities')
                .where({
                    provider_id: provider.id,
                    issuer: claims.iss,
                    subject: claims.sub
                })
                .first();
            if (existingIdentity) {
                throw new Error('That OIDC account is already linked to a Veretube account');
            }

            const hash = await bcrypt.hash(crypto.randomBytes(48).toString('base64'), 10);
            const nowMs = Date.now();
            const [id] = await tx.table('users').insert({
                name,
                password: hash,
                global_rank: 1,
                email: typeof claims.email === 'string' && $util.isValidEmail(claims.email) ?
                    claims.email.substring(0, 255) :
                    '',
                profile: '',
                ip: typeof ip === 'string' ? ip : '',
                time: nowMs,
                name_dedupe: require('./accounts').dedupeUsername(name),
                inactive: false
            });

            await tx.table('user_oidc_identities').insert({
                user_id: id,
                provider_id: provider.id,
                issuer: claims.iss,
                subject: claims.sub,
                email: claims.email || null,
                preferred_username: claims.preferred_username || null,
                created_at: new Date(),
                updated_at: new Date()
            });

            return tx.table('users').where({ id }).first();
        });
    },

    autoProvisionUser: async function autoProvisionUser(provider, claims, ip) {
        return module.exports.createUserForIdentity(provider, claims, ip);
    }
};
