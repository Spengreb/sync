const assert = require('assert');
const crypto = require('crypto');
const customWebhook = require('../../src/integrations/custom-webhook');

describe('custom-webhook integration', () => {
    describe('#normalizeMethod', () => {
        it('accepts supported verbs', () => {
            assert.strictEqual(customWebhook.normalizeMethod('post'), 'POST');
            assert.strictEqual(customWebhook.normalizeMethod('PATCH'), 'PATCH');
        });

        it('rejects unsupported verbs', () => {
            assert.throws(() => customWebhook.normalizeMethod('TRACE'), /method must be/);
        });
    });

    describe('#normalizeUrl', () => {
        it('accepts HTTP URLs', () => {
            assert.strictEqual(
                customWebhook.normalizeUrl('https://example.com/hook'),
                'https://example.com/hook'
            );
        });

        it('rejects credentials in URLs', () => {
            assert.throws(
                () => customWebhook.normalizeUrl('https://user:pass@example.com/hook'),
                /must not include username or password/
            );
        });

        it('rejects non-HTTP URLs', () => {
            assert.throws(() => customWebhook.normalizeUrl('file:///tmp/hook'), /must start with/);
        });
    });

    describe('#normalizeHeaders', () => {
        it('accepts plain header objects', () => {
            assert.deepStrictEqual(
                customWebhook.normalizeHeaders({ 'X-Bot': 'show-runner' }),
                { 'X-Bot': 'show-runner' }
            );
        });

        it('rejects public authorization headers', () => {
            assert.throws(
                () => customWebhook.normalizeHeaders({ Authorization: 'Bearer x' }),
                /Authorization must be configured/
            );
        });

        it('rejects server-managed headers', () => {
            assert.throws(
                () => customWebhook.normalizeHeaders({ Host: 'example.com' }),
                /managed by the server/
            );
        });
    });

    describe('#packSecrets', () => {
        const oldKey = process.env.CALENDAR_SYNC_ENCRYPTION_KEY;

        beforeEach(() => {
            process.env.CALENDAR_SYNC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
        });

        afterEach(() => {
            if (oldKey === undefined) {
                delete process.env.CALENDAR_SYNC_ENCRYPTION_KEY;
            } else {
                process.env.CALENDAR_SYNC_ENCRYPTION_KEY = oldKey;
            }
        });

        it('returns null for empty secrets', () => {
            assert.strictEqual(customWebhook.packSecrets({}), null);
        });

        it('encrypts bearer token and secret headers', () => {
            const packed = customWebhook.packSecrets({
                bearer_token: 'abc123',
                secret_headers: {
                    'X-API-Key': 'secret'
                }
            });
            assert.strictEqual(typeof packed, 'string');
            assert.strictEqual(packed.indexOf('abc123'), -1);
            assert.strictEqual(packed.indexOf('secret'), -1);
        });
    });

    describe('#renderTemplate', () => {
        it('replaces known placeholders and leaves unknown placeholders', () => {
            assert.strictEqual(
                customWebhook.renderTemplate('{show_name} {missing}', {
                    replacements: { show_name: 'Premiere' }
                }),
                'Premiere {missing}'
            );
        });
    });

    describe('#buildTemplateReplacements', () => {
        it('includes show placeholders and rendered notification message aliases', () => {
            const replacements = customWebhook.buildTemplateReplacements('Hello "Premiere"', {
                replacements: {
                    show_name: 'Premiere',
                    show_url: 'https://example.com/r/test'
                }
            });
            assert.strictEqual(replacements.show_name, 'Premiere');
            assert.strictEqual(replacements.show_name_json, 'Premiere');
            assert.strictEqual(replacements.message, 'Hello "Premiere"');
            assert.strictEqual(replacements.notification_message, 'Hello "Premiere"');
            assert.strictEqual(replacements.notification_message_json, 'Hello \\"Premiere\\"');
            assert.strictEqual(replacements.show_url, 'https://example.com/r/test');
        });
    });

    describe('#isPrivateAddress', () => {
        it('identifies private addresses', () => {
            assert.strictEqual(customWebhook.isPrivateAddress('127.0.0.1'), true);
            assert.strictEqual(customWebhook.isPrivateAddress('10.0.0.5'), true);
            assert.strictEqual(customWebhook.isPrivateAddress('192.168.1.5'), true);
            assert.strictEqual(customWebhook.isPrivateAddress('::ffff:127.0.0.1'), true);
            assert.strictEqual(customWebhook.isPrivateAddress('8.8.8.8'), false);
        });
    });
});
