// Optional UI regression suite. Requires a built UI and SHRONCHIK_PLAYWRIGHT.
// All API responses are synthetic; no library or application server is opened.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'src/Shronchik.Server/wwwroot');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
const check = label => { checks++; console.log('PASS ' + label); };

async function queueChecks() {
  const ts = require(path.join(root, 'src/Shronchik.Web/node_modules/typescript'));
  const source = await fs.readFile(path.join(root, 'src/Shronchik.Web/src/asyncQueue.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { AsyncQueue } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const queue = new AsyncQueue(3);
  const signal = new AbortController();
  let active = 0, maximum = 0;
  const all = Array.from({ length: 30 }, (_, index) => queue.run(async () => {
    active++; maximum = Math.max(maximum, active);
    await pause(4);
    active--;
    if (index === 7) throw new Error('Synthetic failed download');
    return index;
  }, signal.signal));
  const settled = await Promise.allSettled(all);
  assert.equal(maximum, 3);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 29);
  check('download queue bounds simultaneous work and continues after a failed image');

  const held = deferred();
  const single = new AsyncQueue(1);
  const first = single.run(() => held.promise, new AbortController().signal);
  const cancelled = new AbortController();
  let started = false;
  const second = single.run(async () => { started = true; }, cancelled.signal);
  const expectedRejection = assert.rejects(second, /locked/);
  cancelled.abort(new Error('Library locked'));
  await expectedRejection;
  held.resolve();
  await first;
  await single.run(async () => {}, new AbortController().signal);
  assert.equal(started, false);
  check('locking cancels queued downloads before they acquire a buffer');
}

async function main() {
  await queueChecks();
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    const appRoute = route === '/' || /^\/(?:photo|video|gif)(?:\/[^/]+)?\/?$/.test(route);
    const file = path.resolve(webRoot, '.' + (appRoute ? '/index.html' : route));
    if (!file.startsWith(webRoot + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const data = await fs.readFile(file);
      const ext = path.extname(file);
      response.writeHead(200, { 'Content-Type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html' });
      response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.SHRONCHIK_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 5120, height: 2160 } });
    page.setDefaultTimeout(12000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async text => { window.copiedLink = text; },
      } });
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
    const item = (index, type = 'photo') => ({ id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`, type,
      title: 'Synthetic ' + type + ' ' + index, description: '', rating: null, views: 0, isFavorite: false,
      size: png.length, createdAt: '2026-01-01T00:00:00Z', tags: ['asia', 'dark-hair'], mimeType: type === 'video' ? 'video/webm' : 'image/png', posterVersion: type === 'video' ? 'synthetic' : null });
    const photos = Array.from({ length: 150 }, (_, index) => item(index + 1));
    const video = item(1000, 'video');
    const neighbor = item(1001, 'video');
    const gif = item(2000, 'gif');
    const album = { id: 'synthetic-album', name: 'Mixed synthetic album', itemCount: 2 };
    const byType = { photo: photos, video: [video], gif: [gif] };
    const byId = new Map([...photos, video, neighbor, gif].map(media => [media.id, media]));
    let authenticated = true, locked = false, activeImages = 0, maxImages = 0, imageRequests = 0, playRequests = 0, neighborRequests = 0;
    let guestMediaRequests = 0;
    let publicOrigin = null;
    let playDelay = null, neighborDelay = null;
    const queries = [];
    const session = () => ({ authenticated: true, locked, role: 'User', accountId: 'synthetic.friend',
      csrfToken: 'synthetic-token', weakPassword: false, mustChangePassword: false, publicOrigin });
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url());
      const endpoint = url.pathname.slice('/api/v1'.length);
      const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      try {
        if (endpoint === '/session' || endpoint === '/session/heartbeat') {
          return authenticated ? await json(session()) : await route.fulfill({ status: 401 });
        }
        if (endpoint === '/auth/login') { authenticated = true; return await json(session()); }
        if (!authenticated && endpoint.startsWith('/media')) {
          guestMediaRequests++;
          return await route.fulfill({ status: 401 });
        }
        if (endpoint === '/auth/lock') { locked = true; return await json(session()); }
        if (endpoint === '/auth/unlock') { locked = false; return await json(session()); }
        if (endpoint === '/home') return await json({ totalCount: 152, totalBytes: 1234, categories: Object.entries(byType).map(([type, items]) => ({ type, count: items.length, totalBytes: 1234 })) });
        if (endpoint === '/tags') return await json(['asia', 'dark-hair']);
        if (endpoint === '/settings') return await json({ language: 'ru', gridColumns: 15, pageBatchSize: 150, showRelatedBelow: false, queryDebounceMs: 20, animationMs: 300 });
        if (endpoint === '/albums') return await json({ items: [album] });
        if (endpoint === `/albums/${album.id}/items`) return await json({ items: [photos[0], video], nextCursor: null, hasMore: false });
        if (endpoint === '/media') {
          queries.push(url.searchParams);
          return await json({ items: byType[url.searchParams.get('type')] ?? [], nextCursor: null, hasMore: false });
        }
        if (/^\/media\/[^/]+$/.test(endpoint)) {
          const media = byId.get(endpoint.slice('/media/'.length));
          return media ? await json(media) : await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'not_found' }) });
        }
        if (endpoint.endsWith('/neighbor')) { neighborRequests++; await neighborDelay?.promise; return await json(neighbor); }
        if (endpoint.endsWith('/related')) return await json({ items: [] });
        if (endpoint.endsWith('/play-sessions')) { playRequests++; return await json({ id: 'synthetic-play' }); }
        if (endpoint.endsWith('/opened')) return await route.fulfill({ status: 204 });
        if (endpoint.endsWith('/first-play')) { await playDelay?.promise; return await route.fulfill({ status: 204 }); }
        if (endpoint.endsWith('/rating') || endpoint.endsWith('/favorite')) return await json(video);
        if (endpoint.endsWith('/poster')) return await route.fulfill({ status: 200, contentType: 'image/png', body: png });
        if (endpoint.endsWith('/stream')) {
          if (endpoint.includes(video.id) || endpoint.includes(neighbor.id)) return await route.fulfill({ status: 415 });
          imageRequests++; activeImages++; maxImages = Math.max(maxImages, activeImages);
          await pause(120);
          try { return await route.fulfill({ status: 200, contentType: 'image/png', body: png }); }
          finally { activeImages--; }
        }
        throw new Error('Unhandled synthetic endpoint ' + endpoint);
      } catch (error) {
        if (!String(error).includes('Target page, context or browser has been closed') && !String(error).includes('Route is already handled')) throw error;
      }
    });
    await page.goto(origin);
    for (const type of Object.keys(byType)) assert.equal(await page.locator(`.category-${type}`).getAttribute('href'), `/${type}`);
    await page.locator('.category-photo').click();
    await page.waitForURL(origin + '/photo');
    await page.waitForFunction(() => document.querySelectorAll('.media-card img').length >= 12);
    assert.ok(maxImages <= 6, `Observed ${maxImages} simultaneous thumbnail requests`);
    assert.ok(imageRequests > 6);
    check('5K gallery keeps image downloads at six rather than starting every visible card together');
    await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
    await page.locator('#login-password').waitFor();
    const countAtLock = imageRequests;
    await pause(350);
    assert.equal(imageRequests, countAtLock);
    assert.equal(await page.locator('.media-card').count(), 0);
    check('lock removes the gallery and queued thumbnails do not keep downloading');
    await page.locator('#login-password').fill('synthetic-password');
    await page.locator('.auth-submit').click();
    await page.getByRole('button', { name: 'Shronchik', exact: true }).click();
    await page.locator('.category-video').click();
    await page.waitForURL(origin + '/video');
    const videoCard = page.locator('.media-card');
    assert.equal(await videoCard.getAttribute('href'), `/video/${video.id}`);
    await videoCard.click();
    const player = page.locator('.player-overlay[open]');
    await player.waitFor();
    const videoUrl = `${origin}/video/${video.id}`;
    await page.waitForURL(videoUrl);
    playDelay = deferred();
    await page.locator('.player-stage video').evaluate(element => element.dispatchEvent(new Event('playing', { bubbles: true })));
    await page.getByRole('button', { name: 'В избранное', exact: true }).click();
    await page.locator('.favorite-button[aria-pressed="true"]').waitFor();
    playDelay.resolve();
    await page.waitForFunction(() => document.querySelector('.file-facts')?.textContent.endsWith('1 просмотр'));
    assert.equal(await page.locator('.favorite-button').getAttribute('aria-pressed'), 'true');
    check('a delayed first-play result preserves a newer favorite change');
    neighborDelay = deferred();
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForTimeout(50);
    assert.equal(neighborRequests, 1);
    const playsBeforeClose = playRequests;
    await page.locator('.back-link').click();
    await page.locator('.player-overlay[data-closing]').waitFor();
    neighborDelay.resolve();
    await pause(80);
    assert.equal(playRequests, playsBeforeClose);
    await player.waitFor({ state: 'hidden' });
    check('video navigation hotkeys work and closing cancels a pending neighbor before it opens');
    await page.locator('.sidebar-toggle').click();
    await page.getByRole('searchbox', { name: 'Поиск по медиатеке', exact: true }).fill('old search');
    await page.locator('.filter-tag').filter({ hasText: 'Dark hair' }).click();
    await page.waitForFunction(() => document.querySelector('.filter-tag.included')?.textContent.includes('Dark hair'));
    await page.locator('.media-card').click();
    await page.locator('.media-tags button').filter({ hasText: 'Asia' }).click();
    await player.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('input[aria-label="Поиск по медиатеке"]')?.value === '');
    await pause(100);
    const last = queries.at(-1);
    assert.equal(last.get('query'), '');
    assert.equal(last.get('includeTags'), 'asia');
    assert.equal(last.get('excludeTags'), '');
    check('a player tag clears the old search and tag filters before showing one selected tag');

    const gifUrl = `${origin}/gif/${gif.id}`;
    await page.goto(origin + '/gif');
    await page.locator('.media-card').click();
    await page.waitForURL(gifUrl);
    await page.getByRole('dialog', { name: gif.title, exact: true }).waitFor();
    await page.goBack();
    await page.waitForURL(origin + '/gif');
    await player.waitFor({ state: 'hidden' });
    await page.goForward();
    await page.waitForURL(gifUrl);
    await page.getByRole('dialog', { name: gif.title, exact: true }).waitFor();
    check('the GIF section opens directly and Back and Forward move between section and file');

    authenticated = false;
    publicOrigin = 'https://media.example.test';
    await page.goto(videoUrl);
    await page.locator('#login-username').fill('synthetic.friend');
    await page.locator('#login-password').fill('synthetic-password');
    assert.equal(page.url(), videoUrl);
    assert.equal(guestMediaRequests, 0);
    await page.locator('.auth-submit').click();
    await page.getByRole('dialog', { name: video.title, exact: true }).waitFor();
    await page.reload();
    await page.getByRole('dialog', { name: video.title, exact: true }).waitFor();
    await page.keyboard.press('Alt+ArrowRight');
    const neighborUrl = `${origin}/video/${neighbor.id}`;
    await page.waitForURL(neighborUrl);
    await page.getByRole('dialog', { name: neighbor.title, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Копировать ссылку', exact: true }).click();
    await page.waitForFunction(url => window.copiedLink === url, `${publicOrigin}/video/${neighbor.id}`);
    await page.locator('.back-link').click();
    await page.waitForURL(origin + '/video');
    await player.waitFor({ state: 'hidden' });
    check('a video link survives sign-in and reload, and copying uses the public origin and current video');

    await page.goto(origin + '/photo');
    await page.getByRole('button', { name: 'Альбомы', exact: true }).click();
    await page.locator('.album-open').filter({ hasText: album.name }).click();
    const albumVideo = page.locator(`.albums-section .media-card[href="/video/${video.id}"]`);
    await albumVideo.click();
    await page.waitForURL(videoUrl);
    await page.getByRole('dialog', { name: video.title, exact: true }).waitFor();
    await page.locator('.back-link').click();
    await page.waitForURL(origin + '/photo');
    await player.waitFor({ state: 'hidden' });
    await albumVideo.waitFor();
    check('opening a video from a photo album uses its video URL and closing returns to that album');

    publicOrigin = null;
    const photoUrl = `${origin}/photo/${photos[0].id}`;
    await page.goto(photoUrl);
    await page.getByRole('dialog', { name: photos[0].title, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Копировать ссылку', exact: true }).click();
    await page.waitForFunction(url => window.copiedLink === url, photoUrl);
    await page.goto(`${origin}/photo/00000000-0000-0000-0000-999999999999`);
    await page.locator('.toast-error').waitFor();
    await player.waitFor({ state: 'hidden' });
    check('a photo opens and copies its direct link, and a missing item shows an error');

    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    check('mobile layout stays within viewport and the regression flows have no uncaught browser errors');
    console.log(`Frontend smoke: ${checks} scenarios passed; peak image requests ${maxImages}.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
