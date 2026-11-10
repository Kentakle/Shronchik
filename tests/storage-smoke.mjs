import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every library, selection file and destination belongs to this synthetic run.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, '.cache', 'storage-smoke', randomUUID());
const original = path.join(workspace, 'original');
const moved = path.join(workspace, 'перенесённая библиотека');
const other = path.join(workspace, 'other');
const selection = path.join(workspace, 'selection.json');
const otherSelection = path.join(workspace, 'other-selection.json');
const serverRoot = path.join(root, 'src', 'Shronchik.Server');
const localDotnet = path.join(root, '.tools', 'dotnet', 'dotnet.exe');
const executable = existsSync(localDotnet) ? localDotnet : 'dotnet';
const port = Number(process.env.SHRONCHIK_STORAGE_TEST_PORT ?? 5283);
const origin = `http://127.0.0.1:${port}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QAAAABJRU5ErkJggg==', 'base64');
const otherPassword = 'synthetic-other-admin-password';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let lockedServer;
let passed = 0;
const check = name => { passed++; console.log(`PASS ${name}`); };

await mkdir(workspace, { recursive: true });

function launch(library, config, selectedPort) {
  const process = spawn(executable, [path.join(serverRoot, 'bin', 'Debug', 'net10.0', 'Shronchik.Server.dll')], {
    cwd: serverRoot, windowsHide: true,
    env: { ...globalThis.process.env, SHRONCHIK_PORT: String(selectedPort), SHRONCHIK_LIBRARY: library,
      SHRONCHIK_STORAGE_CONFIG: config, SHRONCHIK_PUBLIC_ORIGIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.startupError = '';
  process.on('error', error => { process.startupError = error.message; });
  process.stdout.on('data', () => {});
  process.stderr.on('data', data => { process.startupError += data.toString().slice(0, 2000); });
  return process;
}

async function ready(process, selectedPort) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (process.startupError || process.exitCode !== null) throw new Error(`Server failed to start: ${process.startupError}`);
    try { if ((await fetch(`http://127.0.0.1:${selectedPort}/api/v1/health`)).ok) return; } catch { /* starting */ }
    await pause(100);
  }
  throw new Error('Server startup timed out');
}

async function start(library = original, config = selection) {
  server = launch(library, config, port);
  await ready(server, port);
}

async function stopProcess(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  const done = new Promise(resolve => process.once('exit', resolve));
  process.kill();
  await done;
}

async function stop() {
  await stopProcess(server);
}

class Client {
  cookie = '';
  csrf = '';
  async request(route, method = 'GET', body, override = {}) {
    const headers = { Origin: origin, ...override };
    if (this.cookie) headers.Cookie = this.cookie;
    if (method !== 'GET' && this.csrf && !Object.hasOwn(override, 'X-CSRF-Token')) headers['X-CSRF-Token'] = this.csrf;
    if (body !== undefined && !Buffer.isBuffer(body)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const response = await fetch(`${origin}/api/v1${route}`, { method, headers, body });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    return response;
  }
  async json(route, method = 'GET', body, expected = 200, headers) {
    const response = await this.request(route, method, body, headers);
    const content = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${content}`);
    return content ? JSON.parse(content) : null;
  }
  async login(username = 'Admin', password = '1111') {
    const session = await this.json('/auth/login', 'POST', { username, password });
    this.csrf = session.csrfToken;
    return session;
  }
  async reject(route, method, body, code) {
    const response = await this.request(route, method, body);
    const error = await response.json();
    assert.ok(response.status >= 400 && response.status < 600, `${route} unexpectedly succeeded`);
    if (code) assert.equal(error.code, code, `${route}: ${JSON.stringify(error)}`);
    return error;
  }
}

try {
  // Initialise a second independent encrypted library with a distinct password.
  await start(other, otherSelection);
  const secondAdmin = new Client();
  await secondAdmin.login();
  await secondAdmin.json('/auth/password/self', 'POST', { currentPassword: '1111', newPassword: otherPassword });
  await secondAdmin.json('/settings/admin', 'PATCH', { lowDiskWarningGB: 0 });
  await stop();

  await start();
  const admin = new Client();
  const guest = new Client();
  await admin.login();
  await admin.json('/settings/admin', 'PATCH', { lowDiskWarningGB: 0, trashRetentionDays: 17 });
  await admin.json('/settings/ui', 'PATCH', { language: 'en', gridGapPx: 19 });
  await admin.json('/accounts', 'POST', { username: 'reader', password: 'synthetic-temporary-reader' }, 201);
  const reader = new Client();
  await reader.login('reader', 'synthetic-temporary-reader');
  await reader.json('/auth/password/self', 'POST', {
    currentPassword: 'synthetic-temporary-reader', newPassword: 'synthetic-private-reader-password',
  });
  const photo = await admin.json('/imports?fileName=sample.png&title=Storage%20preservation&tags=Asia', 'POST', png, 201);
  const manifest = await readFile(path.join(original, 'library.json'));
  await mkdir(path.join(original, 'additional', 'nested'), { recursive: true });
  await writeFile(path.join(original, 'additional', 'nested', 'keep.txt'), 'whole-library-copy');
  const largeFixture = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  await writeFile(path.join(original, 'additional', 'copy-progress.bin'), largeFixture);

  await guest.json('/storage/folders', 'GET', undefined, 401);
  await reader.json('/storage/folders', 'GET', undefined, 403);
  await guest.json('/storage/folders/pick', 'POST', {}, 401);
  await reader.json('/storage/folders/pick', 'POST', {}, 403);
  await admin.json('/storage/folders/pick', 'POST', {}, 403, { 'X-CSRF-Token': 'invalid' });
  await reader.json('/storage/move', 'POST', { path: moved }, 403);
  await reader.json('/storage/connect', 'POST', { path: other, password: otherPassword }, 403);
  await admin.json('/storage/move', 'POST', { path: moved }, 403, { 'X-CSRF-Token': 'invalid' });
  await admin.json('/storage/connect', 'POST', { path: other, password: otherPassword }, 403, { Origin: 'https://example.org' });
  assert.equal((await admin.json('/storage')).mediaRoot, original);
  check('folder browsing and switching require local Admin, CSRF and same origin');

  const roots = await admin.json('/storage/folders');
  assert.ok(Array.isArray(roots.folders));
  assert.ok(roots.folders.length > 0);
  const listing = await admin.json('/storage/folders?path=' + encodeURIComponent(workspace));
  assert.equal(listing.path, workspace);
  assert.ok(listing.folders.some(folder => folder.path === original));
  const libraryListing = await admin.json('/storage/folders?path=' + encodeURIComponent(original));
  assert.equal(libraryListing.isLibrary, true);
  assert.equal(libraryListing.parentPath, workspace);
  await admin.reject('/storage/folders?path=' + encodeURIComponent('relative-folder'), 'GET', undefined);
  check('server folder picker lists drives and folders and recognises a library');

  const occupied = path.join(workspace, 'occupied');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'keep.txt'), 'do not overwrite');
  await admin.reject('/storage/move', 'POST', { path: occupied }, 'storage_not_empty');
  await admin.reject('/storage/move', 'POST', { path: original }, 'invalid_storage_path');
  await admin.reject('/storage/move', 'POST', { path: path.join(original, 'inside') }, 'invalid_storage_path');
  await admin.reject('/storage/move', 'POST', { path: workspace }, 'invalid_storage_path');
  await admin.reject('/storage/move', 'POST', { path: 'relative-folder' }, 'invalid_storage_path');
  assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'do not overwrite');
  assert.equal((await admin.json('/home')).totalCount, 1);
  assert.deepEqual(await readFile(path.join(original, 'library.json')), manifest);
  check('invalid, nested and nonempty destinations leave both libraries untouched');

  const rejectedStream = await admin.request('/storage/move', 'POST', { path: occupied }, { Accept: 'application/x-ndjson' });
  assert.equal(rejectedStream.status, 200);
  const rejectedEvents = (await rejectedStream.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rejectedEvents.at(-1).type, 'error');
  assert.equal(rejectedEvents.at(-1).code, 'storage_not_empty');
  assert.ok(!rejectedEvents.some(event => event.type === 'complete' || event.percent === 100));
  assert.equal((await admin.json('/storage')).mediaRoot, original);
  check('streamed move errors preserve the current library and never report completion');

  const junction = path.join(workspace, 'linked-original');
  let linkCreated = false;
  try { await symlink(original, junction, process.platform === 'win32' ? 'junction' : 'dir'); linkCreated = true; }
  catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
  if (linkCreated) {
    await admin.reject('/storage/move', 'POST', { path: path.join(junction, 'new-folder') }, 'invalid_storage_path');
    await admin.reject('/storage/connect', 'POST', { path: junction, password: '1111' }, 'invalid_storage_path');
    check('junction/symlink aliases cannot bypass library path validation');
  }

  const moveStream = await admin.request('/storage/move', 'POST', { path: moved }, { Accept: 'application/x-ndjson' });
  assert.equal(moveStream.status, 200);
  assert.match(moveStream.headers.get('content-type'), /application\/x-ndjson/);
  const moveEvents = (await moveStream.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(moveEvents.at(-1).type, 'complete');
  const updates = moveEvents.filter(event => event.type === 'progress');
  assert.ok(updates.length > 1);
  assert.equal(updates.at(-1).percent, 100);
  assert.ok(updates.some(event => event.phase === 'copying' && event.bytesCompleted > 0 && event.percent < 100));
  assert.ok(updates.some(event => event.phase === 'verifying' && event.totalBytes >= largeFixture.length));
  assert.ok(updates.every((event, index) => event.percent >= 0 && event.percent <= 100
    && (index === 0 || event.percent >= updates[index - 1].percent)));
  const movedStatus = moveEvents.at(-1).storage;
  assert.deepEqual(await readFile(path.join(moved, 'additional', 'copy-progress.bin')), largeFixture);
  check('stream sends measured copy and verification progress and completes only after the move');
  assert.equal(movedStatus.mediaRoot, moved);
  assert.equal(movedStatus.databaseRoot, path.join(moved, 'db'));
  assert.deepEqual(await readFile(path.join(moved, 'library.json')), manifest);
  assert.equal(await readFile(path.join(moved, 'additional', 'nested', 'keep.txt'), 'utf8'), 'whole-library-copy');
  if (!movedStatus.sourceRetained) assert.equal(existsSync(original), false);
  assert.equal((await admin.json('/settings')).gridGapPx, 19);
  assert.equal((await admin.json('/settings')).trashRetentionDays, 17);
  assert.ok((await admin.json('/accounts')).items.some(account => account.username === 'reader'));
  assert.equal((await reader.json('/home')).totalCount, 1);
  const movedMedia = await reader.request(`/media/${photo.id}/stream`);
  assert.equal(movedMedia.status, 200);
  assert.deepEqual(Buffer.from(await movedMedia.arrayBuffer()), png);
  check('move preserves manifest, encrypted media, accounts, settings and extra files');

  await stop();
  await start(); // The original environment path intentionally remains unchanged.
  await admin.login();
  await reader.login('reader', 'synthetic-private-reader-password');
  assert.equal((await admin.json('/storage')).mediaRoot, moved);
  assert.equal((await reader.json('/home')).totalCount, 1);
  assert.equal((await admin.json('/settings')).language, 'en');
  assert.ok(existsSync(selection));
  check('restart follows the saved library path and retains user credentials and media');

  await admin.reject('/storage/connect', 'POST', { path: occupied, password: otherPassword }, 'invalid_library');
  await admin.reject('/storage/connect', 'POST', { path: other, password: 'incorrect-admin-password' }, 'invalid_credentials');
  assert.equal((await admin.json('/storage')).mediaRoot, moved);
  assert.equal((await reader.json('/home')).totalCount, 1);
  check('invalid library and wrong target password preserve the active library and sessions');

  lockedServer = launch(other, otherSelection, port + 1);
  await ready(lockedServer, port + 1);
  await admin.reject('/storage/connect', 'POST', { path: other, password: otherPassword }, 'library_in_use');
  assert.equal((await admin.json('/storage')).mediaRoot, moved);
  assert.equal((await reader.json('/home')).totalCount, 1);
  await stopProcess(lockedServer);
  check('a library held by another server cannot be connected and active sessions survive');

  const connected = await admin.json('/storage/connect', 'POST', { path: other, password: otherPassword });
  assert.equal(connected.mediaRoot, other);
  assert.equal((await admin.json('/session')).authenticated, false);
  assert.equal((await reader.json('/session')).authenticated, false);
  await reader.json('/home', 'GET', undefined, 401);
  await admin.login('Admin', otherPassword);
  assert.equal((await admin.json('/home')).totalCount, 0);
  assert.equal((await admin.json('/settings')).language, 'ru');
  assert.deepEqual((await admin.json('/accounts')).items.map(account => account.username), ['Admin']);
  assert.deepEqual(await readFile(path.join(moved, 'library.json')), manifest);
  check('connect loads the selected library and revokes all previous-library sessions');

  await stop();
  await start();
  await admin.login('Admin', otherPassword);
  assert.equal((await admin.json('/storage')).mediaRoot, other);
  assert.equal((await admin.json('/home')).totalCount, 0);
  check('connected library selection survives restart');

  await admin.json('/storage/connect', 'POST', { path: moved, password: '1111' });
  await admin.login();
  assert.equal((await admin.json('/home')).totalCount, 1);
  assert.equal((await admin.json('/settings')).gridGapPx, 19);
  check('previous library remains intact and can be connected again');

  await stop();
  const offline = path.join(workspace, 'offline-library');
  await rename(moved, offline);
  try {
    server = launch(original, selection, port);
    for (let attempt = 0; attempt < 100 && server.exitCode === null; attempt++) await pause(100);
    assert.notEqual(server.exitCode, null, 'missing saved library must stop startup');
    assert.notEqual(server.exitCode, 0, 'missing saved library must fail startup');
    assert.equal(existsSync(original), false, 'startup must not recreate the old default library');
    assert.equal(existsSync(moved), false, 'startup must not recreate the unavailable saved library');
    assert.deepEqual(await readFile(path.join(offline, 'library.json')), manifest);
  } finally {
    await stop();
    await rename(offline, moved);
  }
  check('an unavailable saved library fails closed without creating a fresh library');
  console.log(`Storage smoke: ${passed} scenarios passed. Synthetic data: ${workspace}`);
} finally {
  await stopProcess(lockedServer);
  await stop();
}
