const express = require('express');
const { botAuth, requireRank, getLoadedChannel } = require('./middleware');
const botActor = require('./bot-actor');

const router = express.Router({ mergeParams: true });

const ALLOWED_SETTINGS = new Set([
    'allow_voteskip', 'allow_dupes', 'voteskip_ratio', 'maxlength',
    'playlist_max_duration_per_user', 'afk_timeout', 'enable_link_regex',
    'chat_antiflood', 'chat_antiflood_params', 'chat_antiflood_burst', 'chat_antiflood_sustained',
    'new_user_chat_delay', 'new_user_chat_link_delay', 'pagetitle',
    'password', 'externalcss', 'externaljs', 'show_public', 'torbanned',
    'block_anonymous_users', 'allow_ascii_control', 'playlist_max_per_user'
]);

router.get('/', botAuth, requireRank(4), (req, res) => {
    const chan = getLoadedChannel(req.params.channel);
    if (!chan) return res.status(503).json({ error: 'Channel is not currently active' });

    const opts = chan.modules.options;
    if (!opts) return res.status(503).json({ error: 'Options module not available' });

    const out = {};
    for (const key of ALLOWED_SETTINGS) {
        if (key === 'chat_antiflood_burst' || key === 'chat_antiflood_sustained') {
            const field = key === 'chat_antiflood_burst' ? 'burst' : 'sustained';
            out[key] = opts.get('chat_antiflood_params')[field];
        } else {
            out[key] = opts.get(key);
        }
    }
    res.json(out);
});

router.put('/', botAuth, requireRank(4), (req, res) => {
    const chan = getLoadedChannel(req.params.channel);
    if (!chan) return res.status(503).json({ error: 'Channel is not currently active' });

    const opts = chan.modules.options;
    if (!opts) return res.status(503).json({ error: 'Options module not available' });

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Settings must be an object' });
    }

    const updates = {};
    for (const [key, value] of Object.entries(req.body)) {
        if (ALLOWED_SETTINGS.has(key)) {
            updates[key] = value;
        }
    }

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid settings provided' });
    }

    for (const key of ['externalcss', 'externaljs']) {
        if (key in updates && typeof updates[key] !== 'string') {
            return res.status(400).json({ error: `${key} must be a string` });
        }
    }
    if ('chat_antiflood_params' in updates && (!updates.chat_antiflood_params ||
            typeof updates.chat_antiflood_params !== 'object' || Array.isArray(updates.chat_antiflood_params))) {
        return res.status(400).json({ error: 'chat_antiflood_params must be an object' });
    }
    if ('chat_antiflood_burst' in updates || 'chat_antiflood_sustained' in updates) {
        updates.chat_antiflood_params = Object.assign({}, opts.get('chat_antiflood_params'),
                updates.chat_antiflood_params);
        if ('chat_antiflood_burst' in updates) {
            updates.chat_antiflood_params.burst = updates.chat_antiflood_burst;
            delete updates.chat_antiflood_burst;
        }
        if ('chat_antiflood_sustained' in updates) {
            updates.chat_antiflood_params.sustained = updates.chat_antiflood_sustained;
            delete updates.chat_antiflood_sustained;
        }
    }

    const errors = [];
    const actor = botActor(req.bot, (event, data) => {
        if (event === 'validationError') errors.push(data.message);
        if (event === 'errorMsg') errors.push(data.msg);
    });
    // This validates input, marks the options dirty, applies side effects, and
    // broadcasts the channelOpts event that browser clients already consume.
    opts.handleSetOptions(actor, updates);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    res.json({ success: true });
});

module.exports = router;
