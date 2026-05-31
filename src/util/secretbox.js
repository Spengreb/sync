const crypto = require('crypto');

function decodeKey(base64Key) {
    if (!base64Key || typeof base64Key !== 'string') {
        throw new Error('Missing encryption key');
    }

    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
        throw new Error('Encryption key must decode to exactly 32 bytes');
    }
    return key;
}

function encryptString(plaintext, base64Key) {
    const key = decodeKey(base64Key);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
        cipher.update(String(plaintext), 'utf8'),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptString(ciphertextB64, base64Key) {
    const key = decodeKey(base64Key);
    const raw = Buffer.from(String(ciphertextB64), 'base64');
    if (raw.length < 29) {
        throw new Error('Ciphertext payload is invalid');
    }

    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const ciphertext = raw.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]).toString('utf8');
}

module.exports = {
    encryptString,
    decryptString
};
