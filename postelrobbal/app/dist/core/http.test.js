"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const http_js_1 = require("./http.js");
(0, vitest_1.describe)('hardened outbound HTTP boundaries', () => {
    (0, vitest_1.it)('encodes multiple multipart files with distinct attachment names and caps the count', () => {
        const encoded = (0, http_js_1.encodeMultipartBody)({ chat_id: '-100', media: '[{"media":"attach://file0"},{"media":"attach://file1"}]' }, [
            { fieldName: 'file0', filename: 'one.jpg', contentType: 'image/jpeg', data: Buffer.from('photo-one') },
            { fieldName: 'file1', filename: 'two.jpg', contentType: 'image/jpeg', data: Buffer.from('photo-two') },
        ]);
        const body = encoded.body.toString('utf8');
        (0, vitest_1.expect)(encoded.contentType).toMatch(/^multipart\/form-data; boundary=----PostYarBoundary/);
        (0, vitest_1.expect)(body).toContain('name="chat_id"');
        (0, vitest_1.expect)(body).toContain('attach://file0');
        (0, vitest_1.expect)(body).toContain('name="file0"; filename="one.jpg"');
        (0, vitest_1.expect)(body).toContain('name="file1"; filename="two.jpg"');
        (0, vitest_1.expect)(body).toContain('photo-one');
        (0, vitest_1.expect)(body).toContain('photo-two');
        (0, vitest_1.expect)(body.endsWith('--' + encoded.contentType.split('boundary=')[1] + '--\r\n')).toBe(true);
        (0, vitest_1.expect)(() => (0, http_js_1.encodeMultipartBody)({}, Array.from({ length: 11 }, (_, index) => ({
            fieldName: `file${index}`, filename: `${index}.jpg`, contentType: 'image/jpeg', data: Buffer.from('x'),
        })))).toThrow('MULTIPART_FILE_COUNT_INVALID');
    });
    (0, vitest_1.it)('rejects loopback and private IP addresses before network access', async () => {
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('http://127.0.0.1/resource')).rejects.toThrow();
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('http://192.168.1.20/resource')).rejects.toThrow();
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('http://[::1]/resource')).rejects.toThrow();
    });
    (0, vitest_1.it)('rejects IPv4-mapped IPv6 and other non-global IPv6 destinations', async () => {
        // Node normalizes the dotted mapped form ::ffff:127.0.0.1 to ::ffff:7f00:1.
        // These are rejected before any socket/network request can occur.
        const blocked = [
            'http://[::ffff:7f00:1]/resource',
            'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
            'http://[fe90::1]/resource',
            'http://[febf::1]/resource',
            'http://[64:ff9b::a9fe:a9fe]/resource',
            'http://[2001:1::1]/resource',
            'http://[2002:a9fe:a9fe::1]/resource',
            'http://[3fff::1]/resource',
        ];
        for (const target of blocked) {
            await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)(target)).rejects.toThrow();
        }
    });
    (0, vitest_1.it)('rejects IANA special-purpose, documentation, benchmarking and reserved IPv4 destinations before network access', async () => {
        const blocked = [
            '0.0.0.1',
            '100.64.0.0',
            '100.127.255.255',
            '192.0.0.1',
            '192.0.0.170',
            '192.0.2.0',
            '192.0.2.255',
            '192.88.99.1',
            '198.18.0.0',
            '198.19.255.255',
            '198.51.100.0',
            '198.51.100.255',
            '203.0.113.0',
            '203.0.113.255',
            '224.0.0.1',
            '239.255.255.255',
            '240.0.0.1',
            '255.255.255.255',
        ];
        for (const address of blocked) {
            await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)(`http://${address}/resource`)).rejects.toThrow();
        }
    });
    (0, vitest_1.it)('continues to allow representative public IPv4 literals outside blocked ranges', async () => {
        for (const address of ['1.1.1.1', '8.8.8.8', '198.20.0.1', '198.51.101.1', '203.0.114.1']) {
            await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)(`https://${address}/resource`)).resolves.toBeInstanceOf(URL);
        }
    });
    (0, vitest_1.it)('continues to allow a public global-unicast IPv6 literal', async () => {
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('https://[2606:4700:4700::1111]/resource')).resolves.toBeInstanceOf(URL);
    });
    (0, vitest_1.it)('rejects URL credentials and nonstandard ports before network access', async () => {
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('https://user:pass@8.8.8.8/resource')).rejects.toThrow();
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('https://8.8.8.8:8443/resource')).rejects.toThrow();
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('http://8.8.8.8:443/resource')).rejects.toThrow();
    });
    (0, vitest_1.it)('rejects unsupported schemes', async () => {
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('file:///etc/passwd')).rejects.toThrow();
        await (0, vitest_1.expect)((0, http_js_1.assertSafeUrl)('ftp://example.com/file')).rejects.toThrow();
    });
    (0, vitest_1.it)('keeps non-JSON provider evidence bounded and typed', () => {
        const err = new http_js_1.HttpJsonParseError(502, 'text/html', '<html>gateway</html>');
        (0, vitest_1.expect)(err.code).toBe('HTTP_NON_JSON');
        (0, vitest_1.expect)(err.status).toBe(502);
        (0, vitest_1.expect)(err.contentType).toBe('text/html');
        (0, vitest_1.expect)(err.bodyPreview.length).toBeLessThanOrEqual(240);
    });
});
