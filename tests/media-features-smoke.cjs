// Browser regressions against synthetic APIs and media only. Build the UI first.
// SHRONCHIK_PLAYWRIGHT must point to an installed Playwright package.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'src/Shronchik.Server/wwwroot');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
const check = label => { checks++; console.log('PASS ' + label); };
const clip = Buffer.from('AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMnZwMDltcDQxAAACt21vb3YAAAB4bXZoZAEAAAAAAAAA5xOWbAAAAADnE5ZsAAAD6AAAAAAAAAS1AAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAIPdHJhawAAAGh0a2hkAQAAAwAAAADnE5ZsAAAAAOcTlmwAAAABAAAAAAAAAAAAAAS1AAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAACgAAAAWgAAAAABn21kaWEAAAAsbWRoZAEAAAAAAAAA5xOWbAAAAADnE5ZsAAB1MAAAAAAAAAS1VcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAT5taW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAlZGluZgAAAB1kcmVmAAAAAAAAAAEAAAANdXJsIAAAAAEAAAAA/XN0YmwAAAAQc3RzYwAAAAAAAAAAAAAAEHN0dHMAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAALFzdHNkAAAAAAAAAAEAAAChdnAwOQAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAACgAFoASAAAAEgAAAAAAAAAAQpWUEMgQ29kaW5nAAAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAAAAAAAAAAAABR2cGNDAQAAAAAAgQENAQAAAAAAE2NvbHJuY2x4AAEADQABgAAAAChtdmV4AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAEAbW9vZgAAABBtZmhkAAAAAAAAAAEAAADodHJhZgAAABR0ZmhkAAIAIAAAAAEBAQAAAAAAFHRmZHQBAAAAAAAAAAAAAAAAAAC4dHJ1bgEAAwUAAAAUAAABCAIAAAAAAAauAAAAWQAAB0IAAAARAAAHUwAAABEAAAdFAAAAEQAAB0QAAAARAAAHQQAAAPkAAAc4AAAAEQAAB0EAAAARAAAHQgAAABEAAAdIAAAAEQAAB0YAAAENAAAHKwAAABEAAAdDAAAAEQAAB0MAAAARAAAHRQAAABEAAAc4AAABFgAAB0YAAAARAAAHRQAAABEAAAdTAAAAEQAAA+cAAAARAAAEjW1kYXSCSYNCUAnwBZYGOCQcGDoAAKBH2P1iDNvpPAAAaz50YD5jqkRKSMg1rn11cbzsXTZ3Cal221Se8IxnrchBn61egQwgKiSY1pLv8RUrnU/TEAJwU4DRntsUAIYAQJKcKEggAANwAABZ+YbghgBAkpwoSYAAA3AAAFn5huCGAECSnChIYAADcAAAWfmG4IYAQJKcJEeAAANwAABZ+YbghgBAkpwkRsAAA3AAABYt////yKs////+RVn////yKs////+RVn////yKs///8irP///Iqz///yKs////+RVn///kVZ///5FWf//+RVn////yKs///8irP///Iqz///yKs///+mr/+l7/+l76S//////n7P////5+z////+fs///+frW+///8irP////kVZ////8irP////kVZ///5FWf//+RVn///kVZ///5FWf//+RVn///kVZ///5FWf//+RVn///kVZ///5FWf//+RVn///kVZ//6Xv/6XvpL+wD////5+z////+fs///+fs///+fsJiXVDVnbzAAhgBAkpwgRkAAA3AAAFn5huCGAECSnCBFwAADcAAAWfmG4IYAQJKcIEVAAANwAABZ+YbghgBAkpwgROAAA3AAAFn5huCGAECSnBxEYAADcAAAFi3////bwh////9vCH////28If////bwh////9vCH///t4Q///9vCH///t4Q////+3hD///28If//+3hD///28If////bwh///7eEP///bwh///7eEP////+LP///4s////iz//8KP/////91O8f////dTvH////3U7x///3U7WKP///bwh////9vCH////28If////bwh///7eEP///bwh///7eEP///bwh///7eEP///bwh///7eEP///bwh///7eEP///bwh///7eEP///bwh////iz///+LP//wo//+FH////91O8f////dTvH///dTvH///dTuOCXVDVnbzAIYAQJKcHEQAAANwAABZ+YbghgDAkpwUQQAAA3AAAFn5huCGAECSnBxDoAADcAAAWfmG4IYAQJKcGENAAANwAABZ+YbghgBAkpwYQwAAA3AAABYt////5FRf////kVF////+RUX////5FRf////kVF///8iov///kVF///8iov////yKi///+RUX///yKi///+RUX////5FRf///IqL///5FRf///IqL//////3DGf////7hjP////9wxn///7hjP/////4ZI////+GSP////hkj///hkGfP///kVF////+RUX////5FRf////kVF///8iov///kVF///8iov///kVF///8iov///kVF///8iov///kVF///8iov///kVF///8iov///kVF/////3DGf////7hjP///3DGf///uGM/////hkj////4ZI///4ZI///4ZFKLfgOUWrXACGAECSnBhCwAADcAAAWfmG4IYAQJKcGEKAAANwAABZ+YbghgBAkpwYQkAAA3AAAFn5huCGAECSnBhCAAADcAAAWfmG4AAAAExtZnJhAAAANHRmcmEBAAAAAAAAAQAAAD8AAAABAAAAAAAAAAAAAAAAAAAC2wAAAAEAAAABAAAAAQAAABBtZnJvAAAAAAAAAEw=', 'base64');

const item = (id, type = 'video') => ({ id, type, title: 'Synthetic ' + id, description: '', rating: null,
  views: 0, isFavorite: false, tags: ['dark-hair'], size: type === 'video' ? clip.length : png.length,
  createdAt: '2026-11-08T00:00:00Z', mimeType: { video: 'video/mp4', photo: 'image/png', gif: 'image/gif' }[type],
  posterVersion: type === 'video' ? 'synthetic-cover' : null });
const cards = [item('clip-one'), item('clip-two')];
const requests = [], imports = [], errors = [];
let role = 'Admin', locked = false, playId = 0, played = 0, activeImports = 0, maxImports = 0;
let failOnce = '', importDelay = 40;

async function createServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const endpoint = url.pathname.slice('/api/v1'.length);
    const json = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const session = () => ({ authenticated: true, locked, role, accountId: role === 'Admin' ? 'Admin' : 'synthetic.friend',
      csrfToken: 'synthetic-token', weakPassword: false, mustChangePassword: false });
    try {
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname.startsWith('/api/v1/')) {
        requests.push(endpoint + url.search);
        if (endpoint === '/session' || endpoint === '/session/heartbeat') return json(session());
        if (endpoint === '/auth/lock') { locked = true; return json(session()); }
        if (endpoint === '/auth/unlock') { locked = false; return json(session()); }
        if (endpoint === '/home') return json({ totalCount: cards.length + imports.length, totalBytes: clip.length * 2,
          categories: ['photo', 'video', 'gif'].map(type => ({ type, count: type === 'video' ? cards.length : 0, totalBytes: clip.length })) });
        if (endpoint === '/settings') return json({ language: 'ru', showRelatedBelow: true, volume: .7,
          hoverDelayMs: 300, animationMs: 0, reduceMotion: 'off', lowDiskWarningGB: 0 });
        if (endpoint === '/tags') return json(['asia', 'dark-hair']);
        if (endpoint === '/media') return json({ items: url.searchParams.get('type') === 'video' ? cards : [], nextCursor: null, hasMore: false });
        if (endpoint.endsWith('/play-sessions')) return json({ id: 'play-' + ++playId });
        if (endpoint.endsWith('/first-play')) { played++; response.writeHead(204).end(); return; }
        if (endpoint.endsWith('/opened')) { response.writeHead(204).end(); return; }
        if (endpoint.endsWith('/related')) return json({ items: [cards[1]] });
        if (endpoint.endsWith('/poster')) { response.writeHead(200, { 'Content-Type': 'image/png' }).end(png); return; }
        if (endpoint.endsWith('/stream')) {
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
          const start = range ? Number(range[1]) : 0;
          const end = Math.min(range?.[2] ? Number(range[2]) : clip.length - 1, clip.length - 1);
          const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
          if (range) headers['Content-Range'] = `bytes ${start}-${end}/${clip.length}`;
          response.writeHead(range ? 206 : 200, headers).end(clip.subarray(start, end + 1)); return;
        }
        if (endpoint === '/imports') {
          activeImports++; maxImports = Math.max(maxImports, activeImports);
          const record = { name: url.searchParams.get('fileName'), title: url.searchParams.get('title'), type: url.searchParams.get('type'),
            tags: url.searchParams.get('tags'), csrf: request.headers['x-csrf-token'], bytes: 0 };
          imports.push(record);
          try {
            const gifChunks = [];
            for await (const chunk of request) {
              record.bytes += chunk.length;
              if (record.type === 'gif') gifChunks.push(chunk);
            }
            if (record.type === 'gif') record.payload = Buffer.concat(gifChunks);
            await pause(importDelay);
            if (record.name === failOnce) { failOnce = ''; record.failed = true; return json({ code: 'duplicate' }, 409); }
            return json({ ...item('import-' + imports.length, record.type), title: record.title, tags: record.tags.split(',') }, 201);
          } finally { activeImports--; }
        }
        throw new Error('Unhandled synthetic API ' + request.method + ' ' + endpoint);
      }
      const file = path.resolve(webRoot, '.' + (url.pathname === '/' || url.pathname === '/video' ? '/index.html' : url.pathname));
      if (!file.startsWith(webRoot + path.sep)) { response.writeHead(403).end(); return; }
      const data = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }).end(data);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ECONNRESET') errors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function main() {
  await durationChecks();
  const server = await createServer();
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.SHRONCHIK_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const output = path.join(root, '.cache/media-features-smoke');
    await fs.mkdir(output, { recursive: true });
    await page.goto(origin);
    await albumChecks(page, output);
    await sectionImportChecks(page, output);
    await playbackChecks(page, origin, output);
    assert.deepEqual(errors, []);
    check('all media feature flows finish without uncaught browser or synthetic server errors');
    console.log(`Media features smoke: ${checks} scenarios passed.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function albumChecks(page, output) {
  const dialog = page.locator('.album-import-modal');
  const choose = async names => {
    await dialog.getByLabel('Выбрать фотографии альбома', { exact: true }).setInputFiles(names.map(name => ({ name, mimeType: 'image/png', buffer: png })));
  };
  await page.locator('.category-photo').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).count(), 0);
  assert.equal(await page.locator('.home-page .import-actions').count(), 0);
  await page.locator('.category-photo').click();
  await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).click();
  assert.ok(await dialog.getByLabel('Выбрать фотографии альбома', { exact: true }).getAttribute('multiple') !== null);
  await choose(Array.from({ length: 10 }, (_, index) => `album-${index + 1}.png`));
  assert.equal(await dialog.locator('.album-import-photo').count(), 10);
  await dialog.locator('.tag-picker-options').getByRole('button', { name: 'Asia', exact: true }).click();
  await dialog.locator('.tag-picker-options').getByRole('button', { name: 'Dark hair', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'album-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'album-mobile.png') });
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), await dialog.evaluate(element => JSON.stringify({
    width: element.clientWidth, scroll: element.scrollWidth, children: [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1).map(child => [child.tagName, child.className, child.getBoundingClientRect().right]).slice(0, 15),
  })));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: 'Загрузить фотографии', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.album-import-photo[data-status="done"]').length === 10);
  assert.equal(imports.length, 10);
  assert.equal(maxImports, 1);
  for (const record of imports) {
    assert.equal(record.type, 'photo');
    assert.deepEqual(record.tags.split(',').sort(), ['asia', 'dark-hair']);
    assert.equal(record.csrf, 'synthetic-token');
    assert.equal(record.bytes, png.length);
    assert.equal(record.title, record.name.replace(/\.png$/, ''));
  }
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  check('one album selection uploads all ten photos sequentially with the same tags and preserves each title');

  await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).click();
  await choose(['retry-1.png', 'retry-2.png', 'retry-3.png']);
  failOnce = 'retry-2.png';
  const start = imports.length;
  await dialog.getByRole('button', { name: 'Загрузить фотографии', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.album-import-photo[data-status="done"]').length === 2 &&
    document.querySelectorAll('.album-import-photo[data-status="error"]').length === 1);
  assert.equal(imports.length - start, 3);
  assert.ok(await dialog.getByRole('button', { name: 'Повторить незагруженные', exact: true }).isEnabled());
  assert.ok(await dialog.getByLabel('Найти тег', { exact: true }).isDisabled());
  await dialog.getByRole('button', { name: 'Повторить незагруженные', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.album-import-photo[data-status="done"]').length === 3);
  assert.deepEqual(imports.slice(start).map(record => record.name), ['retry-1.png', 'retry-2.png', 'retry-3.png', 'retry-2.png']);
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  check('photo gallery has its album button and retry uploads only the failed photo after partial success');

  await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).click();
  await dialog.getByLabel('Выбрать фотографии альбома', { exact: true }).setInputFiles([
    { name: 'valid.png', mimeType: 'image/png', buffer: png }, { name: 'wrong.mp4', mimeType: 'video/mp4', buffer: clip },
  ]);
  await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.locator('.album-import-photo').count(), 0);
  await choose(['stop-1.png', 'stop-2.png', 'stop-3.png']);
  importDelay = 600;
  const stopStart = imports.length;
  await dialog.getByRole('button', { name: 'Загрузить фотографии', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.album-import-photo[data-status="uploading"]'));
  await dialog.getByRole('button', { name: 'Остановить', exact: true }).click();
  await dialog.getByRole('button', { name: 'Повторить незагруженные', exact: true }).waitFor({ state: 'visible' });
  await pause(700);
  assert.ok(imports.length - stopStart <= 1);
  assert.equal(await dialog.locator('.album-import-photo[data-status="uploading"]').count(), 0);
  await dialog.locator('.modal-actions').getByRole('button', { name: 'Закрыть', exact: true }).click();
  importDelay = 40;
  check('album rejects non-photo selections and stopping a batch prevents the remaining requests');
}

async function sectionImportChecks(page, output) {
  const dialog = page.locator('.import-modal');
  const fileInput = dialog.getByLabel('Выберите один файл', { exact: true });
  const openImport = async type => {
    await page.locator('.brand').click();
    await page.locator('.category-' + type).click();
    await page.locator('.gallery-tools').getByRole('button', { name: 'Добавить файл', exact: true }).click();
  };
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const pngFile = { name: 'photo.png', mimeType: 'image/png', buffer: png };
  const videoFile = { name: 'clip.mp4', mimeType: 'video/mp4', buffer: clip };
  const gifFile = { name: 'ready.gif', mimeType: 'image/gif', buffer: gif };
  const importsBefore = imports.length;
  for (const [type, extensions, file] of [
    ['photo', '.png,.jpg,.jpeg,.webp', gifFile],
    ['video', '.mp4,.m4v,.mov,.webm', pngFile],
    ['gif', '.gif', videoFile],
  ]) {
    await openImport(type);
    assert.equal(await fileInput.getAttribute('accept'), extensions);
    await fileInput.setInputFiles(file);
    await dialog.getByRole('alert').filter({ hasText: /не подходит для этого раздела/ }).waitFor();
    assert.ok(await dialog.getByRole('button', { name: 'Добавить', exact: true }).isDisabled());
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  }
  assert.equal(imports.length, importsBefore);
  check('every section filters the picker and refuses files from other sections');

  await openImport('gif');
  await fileInput.setInputFiles(gifFile);
  await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(imports.at(-1).type, 'gif');
  assert.deepEqual(imports.at(-1).payload, gif);

  await openImport('gif');
  await dialog.getByRole('button', { name: 'Видео → GIF', exact: true }).click();
  assert.equal(await fileInput.getAttribute('accept'), '.mp4,.m4v,.mov,.webm');
  const convert = dialog.getByRole('button', { name: 'Преобразовать и добавить', exact: true });
  await fileInput.setInputFiles({ ...videoFile, buffer: Buffer.from('invalid video') });
  await convert.click();
  await dialog.getByRole('alert').filter({ hasText: /Не удалось преобразовать/ }).waitFor();
  assert.equal(imports.length, importsBefore + 1);
  await fileInput.setInputFiles(videoFile);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: path.join(output, 'video-to-gif-mobile.png') });
  await convert.click();
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(imports.length, importsBefore + 2);
  const animation = imports.at(-1);
  assert.equal(animation.type, 'gif');
  assert.equal(animation.name, 'clip.gif');
  assert.equal(animation.payload.toString('ascii', 0, 6), 'GIF89a');
  assert.ok((await readGif(page, animation.payload)).frameCount > 5);
  check('GIF import accepts native GIFs and decodes MP4 frames before uploading an animation');

  await openImport('gif');
  await dialog.getByRole('button', { name: 'Видео → GIF', exact: true }).click();
  const video = await makeFullLengthVideo(page);
  await fileInput.setInputFiles({ name: 'full-length.webm', mimeType: 'video/webm', buffer: video });
  await convert.click();
  await dialog.waitFor({ state: 'hidden', timeout: 60_000 });
  assert.equal(imports.length, importsBefore + 3);
  assert.equal(imports.at(-1).name, 'full-length.gif');
  assert.equal(imports.at(-1).type, 'gif');
  const decoded = await readGif(page, imports.at(-1).payload);
  assert.equal(decoded.frameCount, 288);
  assert.equal(decoded.width, 512);
  assert.equal(decoded.height, 288);
  assert.equal(decoded.duration, 12_000_000);
  assert.ok(decoded.lastPixel[2] > 200 && decoded.lastPixel[0] < 80, 'final source frame is present');
  check('12-second WebM converts at 512 × 288 with all 288 frames and the original playback duration');
}

async function makeFullLengthVideo(page) {
  const library = path.join(root, 'src/Shronchik.Web/node_modules/mediabunny/dist/bundles/mediabunny.mjs');
  await page.route('**/test/mediabunny.mjs', route => route.fulfill({ path: library, contentType: 'text/javascript' }));
  const bytes = await page.evaluate(async () => {
    const { BufferTarget, CanvasSource, Output, WebMOutputFormat } = await import('/test/mediabunny.mjs');
    const canvas = new OffscreenCanvas(512, 288);
    const context = canvas.getContext('2d');
    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });
    const source = new CanvasSource(canvas, { codec: 'vp8', bitrate: 1_000_000 });
    const frameRate = 24;
    output.addVideoTrack(source, { frameRate });
    await output.start();
    for (let frame = 0; frame < 12 * frameRate; frame++) {
      context.fillStyle = frame < 11 * frameRate ? '#fa3322' : '#2233fa';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'white';
      context.fillRect(frame, 20, 20, 20);
      await source.add(frame / frameRate, 1 / frameRate);
    }
    await output.finalize();
    return [...new Uint8Array(target.buffer)];
  });
  return Buffer.from(bytes);
}

function readGif(page, payload) {
  return page.evaluate(async bytes => {
    const decoder = new ImageDecoder({ data: new Uint8Array(bytes), type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      const { frameCount } = decoder.tracks.selectedTrack;
      const { image } = await decoder.decode({ frameIndex: frameCount - 1 });
      try {
        const context = new OffscreenCanvas(1, 1).getContext('2d');
        context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
        return {
          frameCount, width: image.displayWidth, height: image.displayHeight,
          duration: image.timestamp + image.duration, lastPixel: [...context.getImageData(0, 0, 1, 1).data],
        };
      } finally { image.close(); }
    } finally { decoder.close(); }
  }, [...payload]);
}

async function durationChecks() {
  const ts = require(path.join(root, 'src/Shronchik.Web/node_modules/typescript'));
  const source = await fs.readFile(path.join(root, 'src/Shronchik.Web/src/videoDuration.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { videoDurationCategory } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  for (const [duration, label] of [[0, null], [-1, null], [NaN, null], [Infinity, null], [1, 'ultra short'], [30, 'ultra short'],
    [30.01, 'short'], [180, 'short'], [180.01, 'medium'], [600, 'medium'], [600.01, 'long'], [1500, 'long'],
    [2399.99, 'long'], [2400, 'ultra long'], [7200, 'ultra long']]) assert.equal(videoDurationCategory(duration), label, String(duration));
  check('duration categories handle every boundary, invalid metadata, and the 25–40 minute gap');
}

async function changeRange(locator, value) {
  await locator.evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function playbackChecks(page, origin, output) {
  const mainVideo = page.locator('.player-stage > video');
  const close = async () => {
    await page.locator('.back-link').click();
    await page.locator('.player-overlay').waitFor({ state: 'hidden' });
  };
  const open = async (index = 0) => {
    await page.locator('.media-card').nth(index).click();
    await page.locator('.player-overlay').waitFor();
    assert.equal(await page.locator('.media-card video').count(), 0, 'opening a player releases the background hover decoder');
    await page.waitForFunction(() => {
      const video = document.querySelector('.player-stage > video');
      return video?.readyState >= 3 && !document.querySelector('.player-stage[data-loading]');
    });
  };
  const setVolume = async value => {
    await changeRange(page.locator('.video-volume'), value);
    await page.waitForFunction(value => Math.abs(document.querySelector('.player-stage > video').volume - value) < .001, value);
  };
  await page.getByRole('button', { name: 'Shronchik', exact: true }).click();
  await page.locator('.category-video').click();
  await page.waitForFunction(() => document.querySelectorAll('.media-card .video-duration').length === 2);
  assert.equal(await page.locator('.media-card .video-duration-category').first().textContent(), 'ultra short');
  const card = page.locator('.media-card').first();
  await card.hover();
  await pause(100);
  assert.equal(await card.locator('video.video-hover-preview').count(), 0);
  await page.waitForFunction(() => {
    const video = document.querySelector('.media-card video');
    return video && !video.paused && video.currentTime > 0;
  });
  assert.ok(await card.locator('video').evaluate(video => video.muted && video.loop && video.playsInline));
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector('.media-card video'));
  assert.equal(played, 0);
  check('hover starts a muted looping thumbnail and releases it on pointer leave without counting a view');

  await open();
  assert.ok(await mainVideo.evaluate(video => video.paused && video.currentTime === 0));
  await setVolume(.23);
  await close();
  await open(1);
  assert.equal(await mainVideo.evaluate(video => video.volume), .23);
  await page.getByRole('button', { name: 'Выключить звук', exact: true }).click();
  await close();
  await page.reload();
  await open();
  assert.ok(await mainVideo.evaluate(video => video.muted && video.volume === .23));
  check('Admin volume and mute survive next video and a full page reload');
  await changeRange(page.locator('.video-seek'), .5);
  await page.waitForFunction(() => Math.abs(document.querySelector('.player-stage > video').currentTime - .5) < .05);
  await mainVideo.focus();
  await page.keyboard.press('Control+Shift+L');
  await page.locator('#login-password').fill('synthetic-password');
  await page.locator('.auth-submit').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('.player-stage > video');
    return video?.readyState >= 3 && !document.querySelector('.player-stage[data-loading]');
  });
  assert.ok(await mainVideo.evaluate(video => video.muted && video.volume === .23 && video.paused && Math.abs(video.currentTime - .5) < .05));
  check('lock and unlock preserve volume, mute, and the paused playback position');
  await page.getByRole('button', { name: 'Включить звук', exact: true }).click();

  const seek = page.locator('input.video-seek');
  const box = await seek.boundingBox();
  const before = await mainVideo.evaluate(video => video.currentTime);
  await page.mouse.move(box.x + box.width * .65, box.y + box.height / 2);
  await page.locator('.timeline-preview').waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.timeline-preview canvas');
    return canvas?.style.visibility === 'visible' && Math.max(...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data.slice(0, 3)) > 24;
  });
  assert.equal(await mainVideo.evaluate(video => video.currentTime), before);
  assert.ok(await mainVideo.evaluate(video => video.paused));
  assert.equal(played, 0);
  await page.screenshot({ path: path.join(output, 'timeline-desktop.png') });
  await page.mouse.move(5, 5);
  await page.locator('.timeline-preview').waitFor({ state: 'hidden' });
  check('timeline hover decodes a frame without seeking, starting, or counting playback');

  await page.getByRole('button', { name: 'На весь экран', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('player-stage'));
  assert.ok(await page.locator('.video-controls').isVisible());
  await page.getByRole('button', { name: 'Выйти из полного экрана', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.ok(await page.locator('.player-overlay[open]').isVisible());
  check('fullscreen includes the stage and custom controls and exits back to the open player');

  await page.locator('.related-card').first().hover();
  await page.waitForFunction(() => {
    const video = document.querySelector('.related-card video');
    return video && !video.paused && video.muted && video.currentTime > 0;
  });
  assert.equal(played, 0);
  assert.equal(await page.locator('.media-card video').count(), 0);
  await page.locator('.back-link').hover();
  await page.waitForFunction(() => !document.querySelector('.related-card video'));
  check('related thumbnails preview inside the open player while background gallery decoders stay unloaded');

  await changeRange(seek, .5);
  await page.waitForFunction(() => Math.abs(document.querySelector('.player-stage > video').currentTime - .5) < .05);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(output, 'player-mobile.png') });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.back-link').hover();
    const mobileSeek = await seek.boundingBox();
    await page.mouse.move(mobileSeek.x + mobileSeek.width * .8, mobileSeek.y + mobileSeek.height / 2);
    await page.waitForFunction(() => document.querySelector('.timeline-preview canvas')?.style.visibility === 'visible');
    const bounds = await page.locator('.timeline-preview').evaluate(element => {
      const box = element.getBoundingClientRect(), stage = element.closest('.player-stage').getBoundingClientRect();
      const seek = document.querySelector('.video-seek').getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, stageLeft: stage.left,
        stageRight: stage.right, stageTop: stage.top, stageBottom: stage.bottom, seekTop: seek.top };
    });
    await page.screenshot({ path: path.join(output, `timeline-mobile-${width}.png`) });
    assert.ok(bounds.left >= bounds.stageLeft + 1 && bounds.right <= bounds.stageRight - 1 &&
      bounds.top >= bounds.stageTop + 1 && bounds.bottom <= bounds.seekTop && bounds.bottom <= bounds.stageBottom,
    `${width}px timeline preview bounds: ${JSON.stringify(bounds)}`);
    if (width === 390) await page.screenshot({ path: path.join(output, 'timeline-mobile.png') });
    await page.mouse.move(5, 5);
  }
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.player-stage > video').paused);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  check('custom seek/play controls work and stay within a phone viewport');
  await close();
  await page.setViewportSize({ width: 1440, height: 1000 });

  role = 'User';
  await page.goto(origin);
  assert.equal(await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).count(), 0);
  await page.locator('.category-video').click();
  await open();
  assert.equal(await mainVideo.evaluate(video => video.volume), .7);
  await setVolume(.41);
  await close();
  await page.reload();
  await open();
  assert.equal(await mainVideo.evaluate(video => video.volume), .41);
  await close();
  role = 'Admin';
  await page.goto(origin);
  await page.locator('.category-video').click();
  await open();
  assert.equal(await mainVideo.evaluate(video => video.volume), .23);
  check('User volume persists across reload and does not overwrite Admin playback preferences');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
