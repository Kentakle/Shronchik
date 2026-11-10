import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGet, request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const library = path.join(root, '.cache', 'http-smoke', randomUUID(), 'library');
await mkdir(path.dirname(library), { recursive: true });
const port = Number(process.env.SHRONCHIK_TEST_PORT ?? 5279);
const origin = `http://127.0.0.1:${port}`;
// Point this at .tools/hosting/server to exercise the exact published HTTPS build.
const publishedServerRoot = process.env.SHRONCHIK_TEST_SERVER_ROOT;
const serverRoot = publishedServerRoot ? path.resolve(publishedServerRoot) : path.join(root, 'src', 'Shronchik.Server');
const serverDll = path.join(serverRoot, ...(publishedServerRoot ? [] : ['bin', 'Debug', 'net10.0']), 'Shronchik.Server.dll');
const localDotnet = path.join(root, '.tools', 'dotnet', 'dotnet.exe');
const executable = existsSync(localDotnet) ? localDotnet : 'dotnet';
let server;
let serverError = '';
let passed = 0;
const check = (name) => { passed++; console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(publicOrigin = '') {
  serverError = '';
  server = spawn(executable, [serverDll], {
    cwd: serverRoot, windowsHide: true,
    env: { ...process.env, SHRONCHIK_PORT: String(port), SHRONCHIK_LIBRARY: library,
      SHRONCHIK_STORAGE_CONFIG: library + '.location.json', SHRONCHIK_PUBLIC_ORIGIN: publicOrigin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.on('error', error => { serverError = error.message; });
  server.stdout.on('data', () => {});
  server.stderr.on('data', data => { serverError += data.toString().slice(0, 1000); });
  for (let i = 0; i < 200; i++) {
    if (serverError || server.exitCode !== null) throw new Error(`Server failed to start: ${serverError}`);
    try { if ((await fetch(`${origin}/api/v1/health`)).ok) return; } catch { /* starting */ }
    await pause(100);
  }
  throw new Error('Server startup timed out');
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
  async request(route, method = 'GET', body, override = {}) {
    const headers = { Origin: origin, ...override };
    if (this.cookie) headers.Cookie = this.cookie;
    if (method !== 'GET' && this.csrf && !Object.hasOwn(override, 'X-CSRF-Token')) headers['X-CSRF-Token'] = this.csrf;
    if (body && !Buffer.isBuffer(body)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const response = await fetch(`${origin}/api/v1${route}`, { method, headers, body });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    return response;
  }
  async json(route, method = 'GET', body, expected = 200, headers) {
    const response = await this.request(route, method, body, headers);
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  async login(role, password = '1111') {
    const session = await this.json('/auth/login', 'POST', { role, password });
    assert.equal(session.role, role);
    this.csrf = session.csrfToken;
    return session;
  }
  async loginUsername(username, password, options = {}) {
    const session = await this.json('/auth/login', 'POST', { username, password, ...options });
    this.csrf = session.csrfToken;
    return session;
  }
}

try {
  const freshHostedOrigin = 'https://fresh.example.test';
  await start(freshHostedOrigin);
  const factoryAdmin = new Client();
  const factorySession = await factoryAdmin.login('Admin');
  assert.equal(factorySession.weakPassword, true);
  assert.equal(factorySession.canUpload, true);
  assert.equal((await new Client().json('/session')).canUpload, false);
  assert.deepEqual((await factoryAdmin.json('/accounts')).items.map(account => account.username), ['Admin']);
  const factoryRemoteLogin = await new Client().request('/auth/login', 'POST', { username: 'Admin', password: '1111' }, {
    Origin: freshHostedOrigin, 'X-Forwarded-Host': 'fresh.example.test',
    'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.42',
  });
  assert.equal(factoryRemoteLogin.status, 403);
  assert.equal((await factoryRemoteLogin.json()).code, 'admin_local_only');
  assert.equal(factoryRemoteLogin.headers.get('set-cookie'), null);
  check('fresh library can host with factory Admin password while Admin remains local-only');
  await stop();
  await start();
  const guest = new Client();
  await guest.json('/home', 'GET', undefined, 401);
  const homePage = await fetch(origin);
  assert.match(await homePage.text(), /Shronchik/i);
  assert.equal(homePage.headers.get('x-frame-options'), 'DENY');
  check('frontend served; unauthenticated API denied');

  const admin = new Client();
  await admin.login('Admin');
  assert.equal((await admin.json('/settings')).language, 'ru');
  assert.equal((await admin.json('/home')).totalCount, 0);
  const allowedTags = ['asia', 'black', 'white', 'latina', 'european', 'dark-hair', 'light-hair',
    'with-makeup', 'without-makeup', 'with-tattoos', 'without-tattoos'];
  assert.deepEqual(await admin.json('/tags'), allowedTags, 'only the eleven requested tags are available in an empty library');
  await admin.json('/session/heartbeat', 'POST', { active: true, playing: false }, 403, { Origin: 'https://example.org' });
  await admin.json('/session/heartbeat', 'POST', { active: true, playing: false }, 403, { 'X-CSRF-Token': 'wrong' });
  const invalidHost = await new Promise((resolve, reject) => {
    httpGet(`${origin}/api/v1/health`, { headers: { Host: `example.org:${port}` } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(invalidHost, 403);
  check('Host, Origin and CSRF enforced');

  const user = new Client();
  assert.deepEqual((await admin.json('/accounts')).items.map(account => account.username), ['Admin']);
  const userPassword = 'synthetic-user-private-password';
  const defaultAccount = await admin.json('/accounts', 'POST', { username: 'User', password: 'temporary-synthetic-user' }, 201);
  assert.equal(defaultAccount.canUpload, false);
  assert.equal((await user.login('User', 'temporary-synthetic-user')).canUpload, false);
  await user.json('/auth/password/self', 'POST', { currentPassword: 'temporary-synthetic-user', newPassword: userPassword });
  const previousSettings = await user.json('/settings');
  await user.json('/settings/ui', 'PATCH', { fontScale: 1.2, gridGapPx: 20, seekSeconds: 12, pageBatchSize: 150, hoverDelayMs: 450 });
  const changedSettings = await user.json('/settings');
  assert.equal(changedSettings.fontScale, 1.2);
  assert.equal(changedSettings.seekSeconds, 12);
  assert.equal(changedSettings.hoverDelayMs, 450);
  assert.equal(changedSettings.accentColor, previousSettings.accentColor);
  assert.equal((await admin.json('/settings')).fontScale, 1);
  await admin.json('/settings/ui', 'PATCH', { gridColumns: 7, afkMinutes: 12 });
  assert.equal((await user.json('/settings')).gridColumns, previousSettings.gridColumns);
  assert.equal((await user.json('/settings')).afkMinutes, previousSettings.afkMinutes);
  await user.json('/settings/ui', 'PATCH', { fontScale: 3 }, 400);
  await user.json('/settings/ui', 'PATCH', { hoverDelayMs: 1201 }, 400);
  await user.json('/settings/ui', 'PATCH', { trashRetentionDays: 7 }, 403);
  await user.json('/settings/admin', 'PATCH', { trashRetentionDays: 7 }, 403);
  await admin.json('/settings/ui', 'PATCH', { thumbnailCandidates: 6 }, 403);
  await admin.json('/settings/admin', 'PATCH', { thumbnailCandidates: 13 }, 400);
  await admin.json('/settings/admin', 'PATCH', { trashRetentionDays: 14, lowDiskWarningGB: 0, thumbnailCandidates: 6 });
  assert.equal((await user.json('/settings')).trashRetentionDays, 14);
  assert.equal((await user.json('/settings')).thumbnailCandidates, 6);
  await user.json('/settings/ui', 'PATCH', { hotkeys: { ...previousSettings.hotkeys, goHome: previousSettings.hotkeys.lock } }, 400);
  check('partial settings preserve other fields, validate ranges and enforce administrative permissions');
  await user.json('/imports?fileName=test.png', 'POST', Buffer.from('test'), 403);
  await user.json('/auth/password', 'POST', { role: 'Admin', currentPassword: '1111', newPassword: 'arbitrary' }, 403);
  await user.json('/trash', 'GET', undefined, 403);
  check('users without upload permission cannot import, change Admin passwords or access trash');

  await guest.json('/accounts', 'POST', { username: 'friend', password: 'temporary-friend-pass' }, 401);
  await user.json('/accounts', 'GET', undefined, 403);
  const friendPassword = 'friend-new-private-password';
  const temporaryPassword = 'temporary-friend-pass';
  const friendAccount = await admin.json('/accounts', 'POST', { username: 'Friend', password: temporaryPassword }, 201);
  assert.equal(friendAccount.username, 'friend');
  assert.equal(friendAccount.role, 'User');
  await admin.json('/accounts', 'POST', { username: 'FRIEND', password: temporaryPassword }, 409);
  const friend = new Client();
  const firstLogin = await friend.loginUsername('Friend', temporaryPassword, { role: 'Admin' });
  assert.equal(firstLogin.role, 'User');
  assert.equal(firstLogin.accountId, 'friend');
  assert.equal(firstLogin.mustChangePassword, true);
  assert.equal((await friend.json('/home', 'GET', undefined, 403)).code, 'password_change_required');
  await friend.json('/albums', 'GET', undefined, 403);
  const upgradedFriend = await friend.json('/auth/password/self', 'POST', { currentPassword: temporaryPassword, newPassword: friendPassword });
  assert.equal(upgradedFriend.mustChangePassword, false);
  await friend.json('/home');
  check('only Admin creates accounts, login roles cannot be forged, temporary passwords block library access');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QAAAABJRU5ErkJggg==', 'base64');
  await admin.json('/imports?fileName=retired-tag.png&tags=amateur', 'POST', png, 400);
  await admin.json('/imports?fileName=custom-tag.png&tags=Unknown', 'POST', png, 400);
  const photo = await admin.json('/imports?fileName=sample.png&title=Quiet%20landscape&tags=' + encodeURIComponent('Asia,Dark hair,With makeup'), 'POST', png, 201);
  assert.equal(photo.type, 'photo');
  assert.equal(photo.rating, null);
  assert.deepEqual(new Set(photo.tags), new Set(['asia', 'dark-hair', 'with-makeup']));
  assert.equal((await user.json('/media?type=photo&includeTags=' + encodeURIComponent('Темные волосы'))).items.length, 1);
  assert.deepEqual(await user.json('/tags'), allowedTags, 'imports do not expand the allowed tag list');
  check('retired and custom import tags are rejected while English labels store canonical IDs');
  await admin.json('/imports?fileName=renamed.png', 'POST', png, 409);
  await admin.json('/imports?fileName=malicious.svg', 'POST', Buffer.from('<svg>test</svg>'), 400);
  const response = await user.request(`/media/${photo.id}/stream`);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  check('single-file import, duplicate rejection and authorized byte-exact stream');

  const blob = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), randomBytes(32 * 1024 * 1024 + 13)]);
  const ratedImport = '/imports?fileName=synthetic.mp4&tags=Asia&rating=';
  assert.equal((await admin.json(ratedImport + '10001', 'POST', blob.subarray(0, 64), 403)).code, 'forbidden');
  await admin.json(ratedImport + '7432', 'POST', blob.subarray(0, 64), 403);
  const video = await admin.json('/imports?fileName=synthetic.mp4&tags=Asia', 'POST', blob, 201);
  assert.equal(video.rating, null);
  assert.equal(video.ratingCount, 0);
  assert.equal(video.userRating, null);
  await user.json(`/media/${video.id}/rating`, 'PUT', { rating: 7432 });
  assert.equal((await user.json(`/media/${video.id}`)).rating, 7432);
  check('Admin cannot set import ratings and imported media starts without votes');
  for (const [range, begin, end] of [
    ['bytes=1048569-1048599', 1048569, 1048599],
    ['bytes=-31', blob.length - 31, blob.length - 1],
    ['bytes=2097152-', 2097152, blob.length - 1],
  ]) {
    const ranged = await user.request(`/media/${video.id}/stream`, 'GET', undefined, { Range: range });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes ${begin}-${end}/${blob.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), blob.subarray(begin, end + 1));
  }
  const invalidRange = await user.request(`/media/${video.id}/stream`, 'GET', undefined, { Range: `bytes=${blob.length}-` });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${blob.length}`);
  check('cross-chunk, suffix, open-ended and invalid HTTP ranges');

  const posterPath = `/media/${video.id}/poster`;
  const posterHeaders = { 'Content-Type': 'image/png' };
  // A 4×4 JPEG with one blue pixel, distinct from the original PNG cover.
  const replacement = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/' +
    '2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAQDASIAAhEBAxEB/' +
    '8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK' +
    'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx' +
    '8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEE' +
    'BSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiIm' +
    'KkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8q2YucnHQDgYoooptuTbbu2B//9k=',
    'base64');
  await user.json(posterPath, 'GET', undefined, 404);
  await guest.json(posterPath, 'GET', undefined, 401);
  await user.json(posterPath, 'PUT', png, 403, posterHeaders);
  await admin.json(`/media/${photo.id}/poster`, 'PUT', png, 400, posterHeaders);
  await admin.json(posterPath, 'PUT', png, 400, { 'Content-Type': 'image/jpeg' });
  const oversizedPoster = Buffer.from(png);
  oversizedPoster.writeUInt32BE(5000, 16);
  await admin.json(posterPath, 'PUT', oversizedPoster, 400, posterHeaders);
  const addedPoster = await admin.json(posterPath, 'PUT', png, 200, posterHeaders);
  const cover = await user.request(posterPath);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/png');
  assert.equal(cover.headers.get('cache-control'), 'no-store, max-age=0');
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), png);
  const updatedPoster = await admin.json(posterPath, 'PUT', replacement, 200, { 'Content-Type': 'image/jpeg' });
  assert.ok(addedPoster.posterVersion);
  assert.notEqual(updatedPoster.posterVersion, addedPoster.posterVersion);
  const videoPage = await user.json('/media?type=video');
  assert.equal(videoPage.items[0].posterVersion, updatedPoster.posterVersion);
  const storedPoster = await readFile(path.join(library, 'vault', 'posters', video.id.replaceAll('-', '') + '.srm'));
  assert.equal(storedPoster.subarray(0, 4).toString(), 'SRM1');
  assert.equal(storedPoster.includes(replacement), false);
  check('video posters are Admin-only to update, validated, versioned and encrypted at rest');

  await admin.json(`/media/${photo.id}/rating`, 'PUT', { rating: 9999 }, 403);
  await admin.json(`/media/${photo.id}/rating`, 'PUT', { rating: null }, 403);
  await user.json(`/media/${photo.id}/rating`, 'PUT', { rating: 1000 });
  const mean = await friend.json(`/media/${photo.id}/rating`, 'PUT', { rating: 3000 });
  assert.equal(mean.rating, 2000);
  assert.equal(mean.userRating, 3000);
  assert.equal(mean.ratingCount, 2);
  assert.equal((await user.json(`/media/${photo.id}`)).userRating, 1000);
  assert.equal((await admin.json(`/media/${photo.id}`)).userRating, null);
  const replacementVote = await user.json(`/media/${photo.id}/rating`, 'PUT', { rating: 5000 });
  assert.equal(replacementVote.rating, 4000);
  assert.equal(replacementVote.ratingCount, 2);
  const clearedVote = await friend.json(`/media/${photo.id}/rating`, 'PUT', { rating: null });
  assert.equal(clearedVote.rating, 5000);
  assert.equal(clearedVote.userRating, null);
  assert.equal(clearedVote.ratingCount, 1);
  check('user votes average, replace and clear independently while Admin rating is forbidden');
  await user.json(`/media/${photo.id}/rating`, 'PUT', { rating: 8750 });
  await user.json(`/media/${photo.id}/favorite`, 'PUT', { isFavorite: true });
  await user.json(`/media/${photo.id}/rating`, 'PUT', { rating: 10001 }, 400);
  const shared = await admin.json(`/media/${photo.id}`);
  assert.equal(shared.rating, 8750);
  assert.equal(shared.isFavorite, true);
  const filtered = await user.json('/media?type=photo&includeTags=ASIA,DARK-HAIR&excludeTags=without-makeup&tab=favorites');
  assert.equal(filtered.items[0].id, photo.id);
  assert.equal((await user.json('/media?type=photo&excludeTags=Asia')).items.length, 0);
  check('shared rating/favorite and include/exclude tag filters');

  const adminPlay = await admin.json(`/media/${video.id}/play-sessions`, 'POST');
  await admin.json(`/play-sessions/${adminPlay.id}/first-play`, 'POST', undefined, 204);
  assert.equal((await admin.json(`/media/${video.id}`)).views, 0);
  const play = await user.json(`/media/${video.id}/play-sessions`, 'POST');
  await user.json(`/play-sessions/${play.id}/first-play`, 'POST', undefined, 204);
  await user.json(`/play-sessions/${play.id}/first-play`, 'POST', undefined, 204);
  assert.equal((await user.json(`/media/${video.id}`)).views, 1);
  await admin.json(`/play-sessions/${play.id}/first-play`, 'POST', undefined, 404);
  check('first play counted once for User; Admin excluded');

  await admin.json(`/media/${photo.id}/opened`, 'POST', undefined, 204);
  await admin.json(`/media/${video.id}/opened`, 'POST', undefined, 204);
  assert.equal((await admin.json('/media?type=photo&tab=history')).items.length, 0);
  assert.equal((await user.json('/media?type=video&tab=history')).items.length, 0);
  await user.json(`/media/${photo.id}/opened`, 'POST', undefined, 204);
  assert.equal((await user.json('/media?type=photo&tab=history')).items[0].id, photo.id);
  assert.equal((await admin.json('/media?type=photo&tab=history')).items.length, 0);
  assert.equal((await friend.json('/media?type=photo&tab=history')).items.length, 0);
  await friend.json(`/media/${video.id}/opened`, 'POST', undefined, 204);
  assert.equal((await friend.json('/media?type=video&tab=history')).items[0].id, video.id);
  assert.equal((await user.json('/media?type=video&tab=history')).items.length, 0);
  assert.equal((await friend.json(`/media/${photo.id}`)).rating, 8750);
  await admin.json(`/media/${photo.id}/trash`, 'POST', undefined, 204);
  await user.json(`/media/${photo.id}/stream`, 'GET', undefined, 404);
  await admin.json(`/trash/${photo.id}/restore`, 'POST', undefined, 204);
  assert.equal((await user.json(`/media/${photo.id}`)).rating, 8750);
  check('each account has private history while shared media remains available');

  const personal = await user.json('/albums', 'POST', { name: 'Private User album' }, 201);
  const friendAlbum = await friend.json('/albums', 'POST', { name: 'Private friend album' }, 201);
  const albumRoute = `/albums/${personal.id}`;
  await user.json(`${albumRoute}/items/${photo.id}`, 'PUT', undefined, 204);
  await user.json(`${albumRoute}/items/${video.id}`, 'PUT', undefined, 204);
  await friend.json(`/albums/${friendAlbum.id}/items/${photo.id}`, 'PUT', undefined, 204);
  assert.deepEqual((await user.json('/albums')).items.map(album => album.id), [personal.id]);
  assert.deepEqual((await friend.json('/albums')).items.map(album => album.id), [friendAlbum.id]);
  assert.equal((await admin.json('/albums')).items.length, 0);
  assert.deepEqual((await friend.json(`/media/${photo.id}/albums`)).albumIds, [friendAlbum.id]);
  await friend.json(`${albumRoute}/items`, 'GET', undefined, 404);
  await admin.json(`${albumRoute}/items`, 'GET', undefined, 404);
  await friend.json(albumRoute, 'PATCH', { name: 'Forbidden rename' }, 404);
  await friend.json(`${albumRoute}/items/${photo.id}`, 'DELETE', undefined, 404);
  await friend.json(albumRoute, 'DELETE', undefined, 404);
  assert.equal((await user.json(albumRoute, 'PATCH', { name: 'Renamed private album' })).name, 'Renamed private album');
  const firstAlbumPage = await user.json(`${albumRoute}/items?limit=1`);
  assert.equal(firstAlbumPage.items.length, 1);
  assert.ok(firstAlbumPage.nextCursor);
  const lastAlbumPage = await user.json(`${albumRoute}/items?limit=1&cursor=${encodeURIComponent(firstAlbumPage.nextCursor)}`);
  assert.notEqual(firstAlbumPage.items[0].id, lastAlbumPage.items[0].id);
  await friend.json(`/albums/${friendAlbum.id}/items?limit=1&cursor=${encodeURIComponent(firstAlbumPage.nextCursor)}`, 'GET', undefined, 400);
  await user.json(`${albumRoute}/items/${video.id}`, 'DELETE', undefined, 204);
  assert.deepEqual((await user.json(`${albumRoute}/items`)).items.map(item => item.id), [photo.id]);
  check('albums enforce ownership on every operation and reject cursors for another album');

  await admin.json('/accounts/friend', 'PATCH', { enabled: false });
  await friend.json('/home', 'GET', undefined, 401);
  await new Client().json('/auth/login', 'POST', { username: 'friend', password: friendPassword }, 401);
  await admin.json('/accounts/friend', 'PATCH', { enabled: true });
  await friend.loginUsername('friend', friendPassword);
  await admin.json('/accounts/friend/password', 'POST', { password: 'replacement-temporary-password' });
  await friend.json('/home', 'GET', undefined, 401);
  assert.equal((await friend.loginUsername('friend', 'replacement-temporary-password')).mustChangePassword, true);
  await friend.json('/auth/password/self', 'POST', { currentPassword: 'replacement-temporary-password', newPassword: friendPassword });
  assert.deepEqual((await friend.json('/albums')).items.map(album => album.id), [friendAlbum.id]);
  check('disabling and resetting revoke active sessions without deleting personal data');

  const activeStream = await user.request(`/media/${video.id}/stream`);
  const reader = activeStream.body.getReader();
  await reader.read();
  // Re-unlock an active session: its old stream generation must also be revoked.
  await user.json('/auth/unlock', 'POST', { password: userPassword });
  let aborted = false;
  try { while (!(await reader.read()).done) { /* drain until cancellation */ } }
  catch { aborted = true; }
  assert.equal(aborted, true, 'repeated unlock must abort the previous stream generation');
  const beforeLock = await user.request(`/media/${video.id}/stream`);
  const lockReader = beforeLock.body.getReader();
  await lockReader.read();
  await user.json('/auth/lock', 'POST');
  let lockAborted = false;
  try { while (!(await lockReader.read()).done) { /* drain until server lock aborts */ } }
  catch { lockAborted = true; }
  assert.equal(lockAborted, true, 'lock must abort an in-flight stream');
  await user.json(`/media/${photo.id}/stream`, 'GET', undefined, 423);
  await user.json(posterPath, 'GET', undefined, 423);
  assert.equal((await user.json('/session')).locked, true);
  await user.json('/auth/unlock', 'POST', { password: userPassword });
  assert.equal((await user.json('/session')).role, 'User');
  check('lock and repeated unlock abort active streams; locked media denied');

  const newPassword = 'a-new-private-password-2026';
  await admin.json('/auth/password', 'POST', { role: 'User', currentPassword: '1111', newPassword });
  await user.json('/home', 'GET', undefined, 401);
  check('Admin password change revokes other role sessions');

  const db = await readFile(path.join(library, 'db', 'catalog.sqlite'));
  assert.notEqual(db.subarray(0,16).toString(), 'SQLite format 3\0');
  assert.equal(db.includes(Buffer.from('Quiet landscape')), false);
  check('catalog is encrypted at rest');

  const uploaderPassword = 'permanent-uploader-private-password';
  const uploaderAccount = await admin.json('/accounts', 'POST', {
    username: 'uploader', password: 'temporary-uploader-password',
  }, 201);
  assert.equal(uploaderAccount.canUpload, false);
  const uploader = new Client();
  assert.equal((await uploader.loginUsername('uploader', 'temporary-uploader-password')).canUpload, false);
  await uploader.json('/auth/password/self', 'POST', {
    currentPassword: 'temporary-uploader-password', newPassword: uploaderPassword,
  });
  const uploadPhotoBytes = Buffer.concat([png, randomBytes(12)]);
  await uploader.json('/imports?fileName=permission-photo.png', 'POST', uploadPhotoBytes, 403);
  await uploader.json('/accounts/uploader', 'PATCH', { canUpload: true }, 403);
  await uploader.json('/accounts/User', 'PATCH', { canUpload: true }, 403);
  await admin.json('/accounts/Admin', 'PATCH', { canUpload: false }, 403);
  await admin.json('/accounts/uploader', 'PATCH', {}, 400);
  await admin.json('/accounts/uploader', 'PATCH', { canUpload: 'true' }, 400);
  const grantedUploader = await admin.json('/accounts/uploader', 'PATCH', { canUpload: true });
  assert.equal(grantedUploader.canUpload, true);
  assert.equal(grantedUploader.enabled, true, 'changing upload permission preserves account access');
  assert.equal((await uploader.json('/session')).canUpload, true, 'permission applies to an existing session');
  assert.equal((await uploader.json('/session/heartbeat', 'POST', { active: true, playing: false })).canUpload, true);
  const uploadPhoto = await uploader.json('/imports?fileName=permission-photo.png&tags=Asia', 'POST', uploadPhotoBytes, 201);
  assert.equal(uploadPhoto.type, 'photo');
  assert.deepEqual(uploadPhoto.tags, ['asia']);
  assert.deepEqual(Buffer.from(await (await friend.request(`/media/${uploadPhoto.id}/stream`)).arrayBuffer()), uploadPhotoBytes);
  await uploader.json('/imports?fileName=permission-photo-copy.png', 'POST', uploadPhotoBytes, 409);
  const uploadGifBytes = Buffer.concat([Buffer.from('GIF89a'), randomBytes(48)]);
  const uploadGif = await uploader.json('/imports?fileName=permission-animation.gif', 'POST', uploadGifBytes, 201);
  assert.equal(uploadGif.type, 'gif');
  const uploadVideoBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), randomBytes(96)]);
  const uploadVideo = await uploader.json('/imports?fileName=permission-video.mp4', 'POST', uploadVideoBytes, 201);
  assert.equal(uploadVideo.type, 'video');
  assert.ok(uploadVideo.importToken, 'new user video imports receive an initial-poster capability');
  for (const item of [photo, uploadPhoto, uploadGif, uploadVideo]) {
    await uploader.json(`/media/${item.id}/trash`, 'POST', undefined, 403);
  }
  await uploader.json('/trash', 'GET', undefined, 403);
  await uploader.json(`/trash/${uploadPhoto.id}/restore`, 'POST', undefined, 403);
  await uploader.json('/accounts', 'GET', undefined, 403);
  await uploader.json('/accounts/uploader', 'DELETE', undefined, 403);
  check('Admin grants upload separately; active users import shared photo, GIF and video without deletion or account privileges');

  const countBeforeSlowUpload = (await admin.json('/home')).totalCount;
  const stagingDirectory = path.join(library, 'staging');
  const stagingBeforeSlowUpload = await readdir(stagingDirectory);
  const slowUploadBytes = Buffer.concat([png, randomBytes(128 * 1024)]);
  let slowUploadRequest;
  const slowUploadResponse = new Promise((resolve, reject) => {
    slowUploadRequest = httpRequest(`${origin}/api/v1/imports?fileName=revoked-during-transfer.png`, {
      method: 'POST', headers: {
        Origin: origin, Cookie: uploader.cookie, 'X-CSRF-Token': uploader.csrf,
        'Content-Type': 'application/octet-stream', 'Content-Length': String(slowUploadBytes.length),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    slowUploadRequest.on('error', reject);
    slowUploadRequest.setTimeout(10000, () => slowUploadRequest.destroy(new Error('Slow upload test timed out')));
    slowUploadRequest.write(slowUploadBytes.subarray(0, 64));
  });
  // Retain errors while waiting to observe the server-side import staging file.
  void slowUploadResponse.catch(() => {});
  try {
    let stagedUpload;
    for (let attempt = 0; attempt < 200 && !stagedUpload; attempt++) {
      stagedUpload = (await readdir(stagingDirectory)).find(file => !stagingBeforeSlowUpload.includes(file));
      if (!stagedUpload) await pause(20);
    }
    assert.ok(stagedUpload, 'the server starts encrypting the upload before permission is revoked');
    await admin.json('/accounts/uploader', 'PATCH', { canUpload: false });
    slowUploadRequest.end(slowUploadBytes.subarray(64));
    const rejectedUpload = await slowUploadResponse;
    assert.equal(rejectedUpload.status, 403, rejectedUpload.body);
    assert.equal(JSON.parse(rejectedUpload.body).code, 'forbidden');
    assert.equal((await admin.json('/home')).totalCount, countBeforeSlowUpload, 'revoked in-flight import is not published');
    assert.deepEqual((await readdir(stagingDirectory)).sort(), stagingBeforeSlowUpload.sort(), 'revoked in-flight import removes staging data');
  } finally {
    slowUploadRequest.destroy();
  }
  await admin.json('/accounts/uploader', 'PATCH', { canUpload: true });
  check('revoking permission during body transfer denies publication and cleans staged upload data');

  const importedPosterPath = `/media/${uploadVideo.id}/poster`;
  const importPosterHeaders = { ...posterHeaders, 'X-Import-Token': uploadVideo.importToken };
  await uploader.json(importedPosterPath, 'PUT', png, 403, posterHeaders);
  await uploader.json(importedPosterPath, 'PUT', png, 403, { ...posterHeaders, 'X-Import-Token': 'invalid-token' });
  await uploader.json(posterPath, 'PUT', png, 403, importPosterHeaders);
  const uploaderSecondSession = new Client();
  await uploaderSecondSession.loginUsername('uploader', uploaderPassword);
  await uploaderSecondSession.json(importedPosterPath, 'PUT', png, 403, importPosterHeaders);
  await uploader.json(importedPosterPath, 'PUT', Buffer.from('invalid poster'), 400, importPosterHeaders);
  const firstUserPoster = await uploader.json(importedPosterPath, 'PUT', png, 200, importPosterHeaders);
  assert.ok(firstUserPoster.posterVersion);
  await uploader.json(importedPosterPath, 'PUT', replacement, 403, {
    'Content-Type': 'image/jpeg', 'X-Import-Token': uploadVideo.importToken,
  });
  assert.deepEqual(Buffer.from(await (await uploader.request(importedPosterPath)).arrayBuffer()), png);
  check('initial user poster capability is bound to its video and session, survives validation errors and cannot replace a saved cover');

  const pendingVideo = await uploader.json('/imports?fileName=permission-pending.mp4', 'POST',
    Buffer.concat([uploadVideoBytes, randomBytes(8)]), 201);
  const revokedUploader = await admin.json('/accounts/uploader', 'PATCH', { canUpload: false });
  assert.equal(revokedUploader.enabled, true);
  assert.equal(revokedUploader.canUpload, false);
  assert.equal((await uploader.json('/session')).canUpload, false);
  assert.equal((await uploaderSecondSession.json('/session')).canUpload, false);
  await uploader.json('/imports?fileName=permission-revoked.png', 'POST', Buffer.concat([png, randomBytes(8)]), 403);
  await uploader.json(`/media/${pendingVideo.id}/poster`, 'PUT', png, 403, {
    ...posterHeaders, 'X-Import-Token': pendingVideo.importToken,
  });
  assert.equal((await uploader.json(`/media/${uploadPhoto.id}`)).id, uploadPhoto.id, 'revoking uploads preserves library access');
  const createdWithPermission = await admin.json('/accounts', 'POST', {
    username: 'upload-at-create', password: 'temporary-upload-at-create-password', canUpload: true,
  }, 201);
  assert.equal(createdWithPermission.canUpload, true);
  const uploadAtCreate = new Client();
  const uploadAtCreateSession = await uploadAtCreate.loginUsername('upload-at-create', 'temporary-upload-at-create-password');
  assert.equal(uploadAtCreateSession.canUpload, true);
  assert.equal(uploadAtCreateSession.mustChangePassword, true);
  assert.equal((await uploadAtCreate.json('/imports?fileName=password-required.png', 'POST', png, 403)).code, 'password_change_required');
  const disabledWithUpload = await admin.json('/accounts/upload-at-create', 'PATCH', { enabled: false, canUpload: true });
  assert.equal(disabledWithUpload.enabled, false);
  assert.equal(disabledWithUpload.canUpload, true);
  await uploadAtCreate.json('/home', 'GET', undefined, 401);
  const stillDisabled = await admin.json('/accounts/upload-at-create', 'PATCH', { canUpload: false });
  assert.equal(stillDisabled.enabled, false, 'upload-only changes cannot re-enable an account');
  const enabledWithUpload = await admin.json('/accounts/upload-at-create', 'PATCH', { enabled: true, canUpload: true });
  assert.equal(enabledWithUpload.enabled, true);
  assert.equal(enabledWithUpload.canUpload, true);
  for (const item of [uploadPhoto, uploadGif, uploadVideo, pendingVideo]) {
    await admin.json(`/media/${item.id}/trash`, 'POST', undefined, 204);
  }
  assert.equal((await admin.json('/home')).totalCount, 2);
  check('revocation immediately blocks imports and pending covers; upload permissions preserve enabled state and mandatory password changes');

  await stop();
  const oldManifest = JSON.parse(await readFile(path.join(library, 'library.json'), 'utf8'));
  delete oldManifest.accounts.friend.canUpload;
  await writeFile(path.join(library, 'library.json'), JSON.stringify(oldManifest));
  await start();
  const afterRestart = new Client();
  const restartedUser = await afterRestart.login('User', newPassword);
  assert.equal(restartedUser.mustChangePassword, true);
  await afterRestart.json('/auth/password/self', 'POST', { currentPassword: newPassword, newPassword: 'permanent-legacy-user-password' });
  const persisted = await afterRestart.json(`/media/${photo.id}`);
  assert.equal(persisted.rating, 8750);
  assert.deepEqual(Buffer.from(await (await afterRestart.request(`/media/${photo.id}/stream`)).arrayBuffer()), png);
  const persistedPoster = await afterRestart.request(posterPath);
  assert.equal(persistedPoster.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await persistedPoster.arrayBuffer()), replacement);
  const persistedVideo = await afterRestart.json(`/media/${video.id}`);
  assert.equal(persistedVideo.posterVersion, updatedPoster.posterVersion);
  assert.equal(persistedVideo.rating, 7432);
  assert.equal((await afterRestart.json('/albums')).items[0].name, 'Renamed private album');
  const friendAfterRestart = new Client();
  assert.equal((await friendAfterRestart.loginUsername('friend', friendPassword)).canUpload, false,
    'legacy accounts missing canUpload stay denied');
  const uploaderAfterRestart = new Client();
  assert.equal((await uploaderAfterRestart.loginUsername('uploader', uploaderPassword)).canUpload, false,
    'revoked upload permission survives restart');
  const permittedAfterRestart = new Client();
  assert.equal((await permittedAfterRestart.loginUsername('upload-at-create', 'temporary-upload-at-create-password')).canUpload, true,
    'granted upload permission survives restart');
  assert.equal((await afterRestart.json('/settings')).fontScale, 1.2);
  assert.equal((await friendAfterRestart.json('/settings')).fontScale, 1);
  assert.equal(persisted.userRating, 8750);
  assert.equal(persisted.ratingCount, 1);
  assert.equal((await friendAfterRestart.json(`/albums/${friendAlbum.id}/items`)).items[0].id, photo.id);
  assert.equal((await friendAfterRestart.json('/media?type=video&tab=history')).items[0].id, video.id);
  check('password, catalog, encrypted media and posters survive server restart');
  const strongAdminPassword = 'strong-hosting-admin-password';
  const adminAfterRestart = new Client();
  await adminAfterRestart.login('Admin');
  const persistedAccounts = (await adminAfterRestart.json('/accounts')).items;
  assert.equal(persistedAccounts.find(account => account.username === 'uploader').canUpload, false);
  assert.equal(persistedAccounts.find(account => account.username === 'upload-at-create').canUpload, true);
  check('granted and revoked upload permissions persist; legacy manifests default to no upload permission');
  await adminAfterRestart.json('/auth/password/self', 'POST', { currentPassword: '1111', newPassword: strongAdminPassword });
  // Local compatibility allows a weak legacy password, but the account must
  // remain disabled until the local administrator gives it a strong password.
  await adminAfterRestart.json('/auth/password', 'POST', { role: 'User', currentPassword: strongAdminPassword, newPassword: '1234' });
  await stop();
  const hostedOrigin = 'https://media.example.test';
  await assert.rejects(start(hostedOrigin), /weak user passwords/i);
  await stop();
  await start();
  const recoveredAdmin = new Client();
  await recoveredAdmin.login('Admin', strongAdminPassword);
  await recoveredAdmin.json('/accounts/User', 'PATCH', { enabled: false });
  await stop();
  check('hosting still rejects enabled weak User accounts and local recovery can disable them');
  await start(hostedOrigin);
  const localAdmin = new Client();
  await localAdmin.login('Admin', strongAdminPassword);
  const proxyHeaders = {
    Origin: hostedOrigin, 'X-Forwarded-Host': 'media.example.test',
    'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.42',
  };
  for (const credentials of [
    { username: 'Admin', password: strongAdminPassword },
    { username: ' aDmIn ', password: strongAdminPassword },
    { role: 'Admin', password: strongAdminPassword },
  ]) {
    const rejected = await new Client().request('/auth/login', 'POST', credentials, proxyHeaders);
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'admin_local_only');
    assert.equal(rejected.headers.get('set-cookie'), null, 'Remote Admin login must not create a session');
  }
  check('HTTPS rejects Admin login by normalized username and legacy role');

  const copiedAdmin = new Client();
  copiedAdmin.cookie = localAdmin.cookie;
  copiedAdmin.csrf = localAdmin.csrf;
  for (const [route, method, body] of [
    ['/session', 'GET'], ['/home', 'GET'], ['/accounts', 'GET'],
    [`/media/${photo.id}/stream`, 'GET'],
    ['/auth/unlock', 'POST', { password: strongAdminPassword }],
    ['/auth/logout', 'POST'],
  ]) {
    assert.equal((await copiedAdmin.json(route, method, body, 403, proxyHeaders)).code, 'admin_local_only');
  }
  for (const headers of [
    { 'X-Forwarded-For': '127.0.0.1' },
    { 'X-Forwarded-For': '::1' },
    { Forwarded: 'for=127.0.0.1;host=localhost' },
    { 'X-Original-Host': `localhost:${port}` },
  ]) {
    assert.equal((await copiedAdmin.json('/session', 'GET', undefined, 403, headers)).code, 'admin_local_only');
    assert.equal((await new Client().json('/auth/login', 'POST', {
      username: 'Admin', password: strongAdminPassword,
    }, 403, headers)).code, 'admin_local_only');
  }
  assert.equal((await copiedAdmin.json('/session', 'GET', undefined, 403, {
    ...proxyHeaders, 'X-Forwarded-For': '127.0.0.1',
  })).code, 'admin_local_only');
  assert.equal((await localAdmin.json('/session')).role, 'Admin');
  assert.equal((await localAdmin.json('/session', 'GET', undefined, 200, { Host: `localhost:${port}` })).role, 'Admin');
  assert.equal((await localAdmin.json('/home')).totalCount, 2);
  await localAdmin.json('/auth/lock', 'POST');
  assert.equal((await copiedAdmin.json('/auth/unlock', 'POST', { password: strongAdminPassword }, 403, proxyHeaders)).code, 'admin_local_only');
  assert.equal((await localAdmin.json('/session')).locked, true);
  assert.equal((await localAdmin.json('/auth/unlock', 'POST', { password: strongAdminPassword })).locked, false);
  check('Admin cookies and spoofed loopback forwarding cannot bypass local access or revoke the local session');

  const hosted = new Client();
  const remoteLogin = await hosted.request('/auth/login', 'POST', { username: 'friend', password: friendPassword, role: 'Admin' }, proxyHeaders);
  assert.equal(remoteLogin.status, 200);
  assert.match(remoteLogin.headers.get('set-cookie'), /; secure/i);
  const hostedSession = await remoteLogin.json();
  assert.equal(hostedSession.role, 'User');
  hosted.csrf = hostedSession.csrfToken;
  await hosted.json('/home', 'GET', undefined, 200, proxyHeaders);
  const hostedTags = await hosted.request('/tags', 'GET', undefined, proxyHeaders);
  assert.equal(hostedTags.status, 200);
  assert.match(hostedTags.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await hostedTags.json(), allowedTags);
  const hostedPage = await fetch(origin, { headers: proxyHeaders });
  assert.equal(hostedPage.status, 200);
  assert.match(hostedPage.headers.get('cache-control'), /no-store/);
  const hostedHtml = await hostedPage.text();
  assert.equal(hostedHtml, await readFile(path.join(serverRoot, 'wwwroot', 'index.html'), 'utf8'));
  const assets = [...hostedHtml.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(asset => asset.endsWith('.js')));
  for (const asset of assets) {
    const response = await fetch(origin + asset, { headers: proxyHeaders });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(serverRoot, 'wwwroot', asset)));
  }
  check('HTTPS friend receives exactly eleven current tags and the published frontend assets without caching');
  await localAdmin.json('/accounts/friend', 'PATCH', { canUpload: true });
  assert.equal((await hosted.json('/session', 'GET', undefined, 200, proxyHeaders)).canUpload, true);
  const hostedPhoto = await hosted.json('/imports?fileName=https-permitted.png', 'POST',
    Buffer.concat([png, randomBytes(12)]), 201, proxyHeaders);
  await hosted.json(`/media/${hostedPhoto.id}/trash`, 'POST', undefined, 403, proxyHeaders);
  await localAdmin.json('/accounts/friend', 'PATCH', { canUpload: false });
  await hosted.json('/imports?fileName=https-revoked.png', 'POST',
    Buffer.concat([png, randomBytes(12)]), 403, proxyHeaders);
  await localAdmin.json(`/media/${hostedPhoto.id}/trash`, 'POST', undefined, 204);
  check('authorized HTTPS users upload without deletion rights and remote uploads stop immediately after revocation');
  const weakEnable = await localAdmin.json('/accounts/User', 'PATCH', { enabled: true }, 400);
  assert.equal(weakEnable.code, 'weak_password');
  await localAdmin.json('/auth/password', 'POST', { role: 'User', currentPassword: strongAdminPassword, newPassword: '5678' }, 400);
  assert.equal((await localAdmin.json('/accounts')).items.find(account => account.username === 'User').enabled, false);
  await localAdmin.json('/accounts/User/password', 'POST', { password: 'strong-remote-temporary-password' });
  await localAdmin.json('/accounts/User', 'PATCH', { enabled: true });
  await hosted.json('/home', 'GET', undefined, 403, { ...proxyHeaders, 'X-Forwarded-Host': 'evil.example.test' });
  await hosted.json('/auth/lock', 'POST', undefined, 403, { ...proxyHeaders, Origin: 'https://evil.example.test' });
  await hosted.json('/accounts', 'GET', undefined, 403, proxyHeaders);
  check('configured HTTPS proxy validates hosts, Origin, Secure cookies and live weak-account changes');
  await localAdmin.json('/accounts/Admin', 'DELETE', undefined, 403);
  await localAdmin.json('/accounts', 'POST', { username: 'erase.me', password: 'temporary-delete-test-password' }, 201);
  const deletedUser = new Client();
  await deletedUser.loginUsername('erase.me', 'temporary-delete-test-password');
  await deletedUser.json('/auth/password/self', 'POST', { currentPassword: 'temporary-delete-test-password', newPassword: 'permanent-delete-test-password' });
  const erasedAlbum = await deletedUser.json('/albums', 'POST', { name: 'Will be removed' }, 201);
  await deletedUser.json(`/albums/${erasedAlbum.id}/items/${photo.id}`, 'PUT', undefined, 204);
  await deletedUser.json(`/media/${photo.id}/opened`, 'POST', undefined, 204);
  const deletedPlay = await deletedUser.json(`/media/${video.id}/play-sessions`, 'POST');
  await deletedUser.json(`/play-sessions/${deletedPlay.id}/first-play`, 'POST', undefined, 204);
  await deletedUser.json('/accounts/friend', 'DELETE', undefined, 403);
  await localAdmin.json('/accounts/erase.me', 'DELETE', undefined, 204);
  await deletedUser.json('/home', 'GET', undefined, 401);
  await localAdmin.json('/accounts/erase.me', 'DELETE', undefined, 204);
  await localAdmin.json('/accounts', 'POST', { username: 'erase.me', password: 'temporary-recreated-password' }, 201);
  const recreated = new Client();
  await recreated.loginUsername('erase.me', 'temporary-recreated-password');
  await recreated.json('/auth/password/self', 'POST', { currentPassword: 'temporary-recreated-password', newPassword: 'permanent-recreated-password' });
  assert.equal((await recreated.json('/albums')).items.length, 0);
  assert.equal((await recreated.json('/media?type=photo&tab=history')).items.length, 0);
  assert.equal((await recreated.json(`/media/${photo.id}`)).rating, 8750);
  await recreated.json(`/albums/${erasedAlbum.id}/items`, 'GET', undefined, 404);
  check('account deletion revokes sessions and erases personal data before login reuse, preserving shared media');
  await localAdmin.json('/accounts/User', 'DELETE', undefined, 204);
  await stop();
  const manifestPath = path.join(library, 'library.json');
  const interrupted = JSON.parse(await readFile(manifestPath, 'utf8'));
  interrupted.accounts['erase.me'].enabled = false;
  interrupted.accounts['erase.me'].pendingDeletion = true;
  await writeFile(manifestPath, JSON.stringify(interrupted));
  await start();
  const afterDeletion = new Client();
  await afterDeletion.login('Admin', strongAdminPassword);
  const remainingAccounts = (await afterDeletion.json('/accounts')).items.map(account => account.username);
  assert.equal(remainingAccounts.includes('User'), false);
  assert.equal(remainingAccounts.includes('erase.me'), false);
  assert.equal(remainingAccounts.includes('friend'), true);
  assert.equal((await afterDeletion.json('/home')).totalCount, 2);
  check('deleted User stays absent after restart and pending deletion resumes on Admin sign-in');
  console.log(`HTTP smoke: ${passed} scenarios passed.`);
} finally {
  await stop();
}
