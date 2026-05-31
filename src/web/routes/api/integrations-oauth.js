const express = require('express');
const webserver = require('../../webserver');
const Config = require('../../../config');
const calendarDB = require('../../../database/calendar-integrations');
const googleCalendar = require('../../../integrations/google-calendar');
const { getChannelRow, getUserEffectiveRank } = require('./middleware');

const router = express.Router();

router.get('/google/callback', async (req, res) => {
    const user = await webserver.authorize(req);
    if (!user) return res.status(401).send('Unauthorized');

    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();
    if (!code || !state) return res.status(400).send('Missing code/state');

    let decoded;
    try {
        decoded = googleCalendar.decodeState(state, Config.get('http.cookie-secret'));
    } catch (err) {
        return res.status(400).send(err.message || 'Invalid state');
    }

    if (!decoded.channel || !decoded.calendarId) {
        return res.status(400).send('State is missing channel/calendar info');
    }
    if (String(decoded.actor || '').toLowerCase() !== String(user.name || '').toLowerCase()) {
        return res.status(403).send('OAuth callback user mismatch');
    }

    const channelRow = await getChannelRow(decoded.channel).catch(() => null);
    if (!channelRow) return res.status(404).send('Channel not found');

    const rank = await getUserEffectiveRank(user, channelRow);
    if (rank < 3) return res.status(403).send('Insufficient rank');

    try {
        const tokenPayload = await googleCalendar.exchangeCodeForToken(code);
        const packed = googleCalendar.packTokens(tokenPayload);
        await calendarDB.upsertGoogleIntegration(channelRow.id, {
            status: 'connected',
            config: {
                calendar_id: decoded.calendarId,
                sync_statuses: ['scheduled', 'running', 'paused', 'completed']
            },
            token_encrypted: packed.token_encrypted,
            refresh_token_encrypted: packed.refresh_token_encrypted,
            token_expires_at: packed.token_expires_at,
            connected_by: user.name,
            updated_by: user.name
        });
        res.send(`Google Calendar connected for channel ${channelRow.name}. You can close this tab.`);
    } catch (err) {
        res.status(400).send(err.message || 'OAuth exchange failed');
    }
});

module.exports = router;
