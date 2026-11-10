import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const library = path.join(root, '.cache/security-smoke', randomUUID(), 'library');
const port = Number(process.env.SHRONCHIK_SECURITY_PORT ?? 5281);
const origin = `http://127.0.0.1:${port}`;
const serverRoot = path.join(root, 'src/Shronchik.Server');
const localDotnet = path.join(root, '.tools/dotnet/dotnet.exe');
let server;
let passed = 0;
const check = name => { passed++; console.log('PASS ' + name); };
await mkdir(path.dirname(library), { recursive: true });

async function start(publicOrigin = '') {
  server = spawn(existsSync(localDotnet) ? localDotnet : 'dotnet', [path.join(serverRoot, 'bin/Debug/net10.0/Shronchik.Server.dll')], {
    cwd: serverRoot, windowsHide: true,
    env: { ...process.env, SHRONCHIK_LIBRARY: library, SHRONCHIK_PORT: String(port),
      SHRONCHIK_STORAGE_CONFIG: library + '.location.json', SHRONCHIK_PUBLIC_ORIGIN: publicOrigin },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let failure = '';
  server.stderr.on('data', data => { failure += data.toString().slice(0, 2000); });
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error('Isolated server failed: ' + failure);
    try { if ((await fetch(origin + '/api/v1/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated server startup timed out');
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise(resolve => server.once('exit', resolve));
  server.kill();
  await done;
}
class Client {
  cookie = '';
  csrf = '';
  async request(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: { Origin: origin, Cookie: this.cookie, 'X-CSRF-Token': this.csrf, ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  async json(route, method = 'GET', body, status = 200, headers = {}) {
    const response = await this.request('/api/v1' + route, { method, body, headers });
    const text = await response.text();
    assert.equal(response.status, status, method + ' ' + route + ': ' + text.slice(0, 400));
    return text ? JSON.parse(text) : null;
  }
  async login(username, password) {
    const session = await this.json('/auth/login', 'POST', { username, password });
    this.csrf = session.csrfToken;
    return session;
  }
}
function raw(pathname, { method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin + pathname, { method, headers: { Origin: origin, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

try {
  await start();
  const guest = new Client();
  const oversized = { username: 'x'.repeat(100_000), password: 'x' };
  const oversizedResponse = await guest.request('/api/v1/auth/login', { method: 'POST', body: oversized });
  if (process.env.SHRONCHIK_SECURITY_BASELINE) {
    console.log(JSON.stringify({ oversizedLoginBodyBytes: Buffer.byteLength(JSON.stringify(oversized)), actualStatus: oversizedResponse.status, requiredStatus: 413 }));
    process.exitCode = oversizedResponse.status === 413 ? 0 : 1;
  } else {
    assert.equal(oversizedResponse.status, 413, 'Oversized unauthenticated login JSON must be rejected before binding');
    check('unauthenticated JSON body is bounded before deserialization');
    const chunked = await raw('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, chunks: [JSON.stringify(oversized)] });
    assert.equal(chunked.status, 413, 'Chunked JSON must respect the same body limit');
    check('chunked JSON cannot bypass the request body limit');

    const admin = new Client();
    const adminSession = await admin.login('Admin', '1111');
    assert.equal(adminSession.role, 'Admin');
    const anonymous = new Client();
    const deniedRoutes = ['/home', '/tags', '/accounts', '/settings', '/albums', '/trash', '/storage'];
    for (const route of deniedRoutes) await anonymous.json(route, 'GET', undefined, 401);
    await admin.json('/session/heartbeat', 'POST', { active: true, playing: false }, 403, { 'X-CSRF-Token': '' });
    await admin.json('/session/heartbeat', 'POST', { active: true, playing: false }, 403, { Origin: 'https://attacker.invalid' });
    await admin.json('/session/heartbeat', 'POST', { active: true, playing: false }, 403, { Origin: 'null' });
    const rebound = await raw('/api/v1/health', { headers: { Host: `attacker.invalid:${port}` } });
    assert.equal(rebound.status, 403);
    const protectedError = await anonymous.request('/api/v1/home');
    assert.equal(protectedError.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(protectedError.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(protectedError.headers.get('cache-control'), 'no-store, max-age=0');
    check('anonymous data access, forged Origin/CSRF and DNS-rebinding Host are rejected');

    const friendPassword = 'permanent-security-test-password';
    for (const username of ['alice', 'bob']) {
      await admin.json('/accounts', 'POST', { username, password: 'temporary-security-test-password' }, 201);
    }
    const alice = new Client();
    const first = await alice.login('alice', 'temporary-security-test-password');
    assert.equal(first.mustChangePassword, true);
    await alice.json('/home', 'GET', undefined, 403);
    await alice.json('/auth/password/self', 'POST', { currentPassword: 'temporary-security-test-password', newPassword: friendPassword });
    const bob = new Client();
    await bob.login('bob', 'temporary-security-test-password');
    await bob.json('/auth/password/self', 'POST', { currentPassword: 'temporary-security-test-password', newPassword: friendPassword });
    for (const [route, method, body] of [
      ['/accounts', 'POST', { username: 'evil', password: friendPassword }],
      ['/accounts/bob', 'DELETE'], ['/accounts/bob', 'PATCH', { enabled: false }],
      ['/accounts/bob/password', 'POST', { password: friendPassword }],
      ['/settings/admin', 'PATCH', { trashRetentionDays: 1 }], ['/storage/check', 'POST'],
      ['/imports?fileName=evil.png', 'POST', Buffer.from('bad')],
    ]) await alice.json(route, method, body, 403);
    check('ordinary account cannot escalate roles or mutate accounts, storage and imports');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QAAAABJRU5ErkJggg==', 'base64');
    const injectedTitle = '<img src=x onerror=alert(1)>\' OR 1=1; --';
    const photo = await admin.json('/imports?fileName=neutral.png&title=' + encodeURIComponent(injectedTitle), 'POST', png, 201);
    assert.equal((await alice.json('/media?type=photo&query=' + encodeURIComponent("' OR 1=1; --"))).items.length, 1);
    assert.equal((await alice.json('/media?type=photo&query=' + encodeURIComponent("' UNION SELECT secret --"))).items.length, 0);
    assert.equal((await alice.json('/media/' + photo.id)).title, injectedTitle);
    const album = await alice.json('/albums', 'POST', { name: injectedTitle }, 201);
    await alice.json(`/albums/${album.id}/items/${photo.id}`, 'PUT', undefined, 204);
    for (const [route, method, body] of [
      [`/albums/${album.id}/items`, 'GET'], [`/albums/${album.id}`, 'PATCH', { name: 'stolen' }],
      [`/albums/${album.id}`, 'DELETE'], [`/albums/${album.id}/items/${photo.id}`, 'DELETE'],
    ]) await bob.json(route, method, body, 404);
    assert.equal((await alice.json(`/albums/${album.id}/items`)).items[0].id, photo.id);
    check('SQL-like input remains data and foreign album IDs cannot be read or mutated');

    const vaultId = photo.id.replaceAll('-', '');
    for (const pathname of ['/library.json', '/db/catalog.sqlite', `/vault/${vaultId.slice(0, 2)}/${vaultId}.srm`, '/api/v1/media/%2e%2e%2flibrary.json/stream', '/api/v1/../../data/library/library.json']) {
      const response = await raw(pathname, { headers: { Cookie: admin.cookie } });
      assert.ok([200, 400, 401, 403, 404].includes(response.status), 'Unexpected traversal response status at ' + pathname + ': ' + response.status);
      assert.ok(!response.body.includes('"accounts"') && !response.body.includes('SQLite format 3'), 'Sensitive file exposed at ' + pathname);
      if (response.status === 200) assert.match(response.body, /<!doctype html>/i);
    }
    check('traversal and guessed storage URLs expose neither manifest nor encrypted files');

    const media = await alice.request(`/api/v1/media/${photo.id}/stream`);
    assert.equal(media.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(media.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(media.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
    const forgedSession = new Client();
    forgedSession.cookie = 'shronchik.session=' + '0'.repeat(64);
    await forgedSession.json('/home', 'GET', undefined, 401);
    await alice.json('/auth/lock', 'POST');
    await alice.json(`/media/${photo.id}/stream`, 'GET', undefined, 423);
    await alice.json('/albums', 'GET', undefined, 423);
    await alice.json('/auth/unlock', 'POST', { password: friendPassword });
    await alice.json('/auth/logout', 'POST');
    await alice.json('/home', 'GET', undefined, 401);
    check('media has privacy headers; forged, locked and logged-out sessions cannot read protected data');

    const failures = new Client();
    await failures.json('/auth/login', 'POST', { username: 'missing', password: '1111' }, 401);
    await failures.json('/auth/login', 'POST', { username: 'another-missing', password: 'wrong' }, 429);
    await bob.json('/home');
    check('unknown username flood shares a bounded backoff bucket and leaves active users available');
    const manifest = JSON.parse(await readFile(path.join(library, 'library.json'), 'utf8'));
    assert.equal(Object.keys(manifest.accounts).length, 3);
    assert.equal((await admin.json('/home')).totalCount, 1);
    const loginBurst = await Promise.all(Array.from({ length: 64 }, async () => {
      const client = new Client();
      const response = await client.request('/api/v1/auth/login', { method: 'POST', body: { username: 'Admin', password: '1111' } });
      await response.arrayBuffer();
      return response.status;
    }));
    assert.ok(loginBurst.every(status => status === 200 || status === 429));
    assert.ok(loginBurst.includes(429), 'Concurrent login burst must be rejected beyond the bounded queue');
    check('login burst has a bounded queue and excess requests receive 429');
    console.log(`Security smoke: ${passed} scenarios passed. Only synthetic data was used.`);
  }
} finally {
  await stop();
}
