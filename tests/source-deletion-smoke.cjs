// Source cleanup regressions use synthetic APIs and in-memory files only.
// Build the UI first; SHRONCHIK_PLAYWRIGHT points to an installed Playwright package.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'src/Shronchik.Server/wwwroot');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
const check = label => { checks++; console.log('PASS ' + label); };

async function loadModule(relative) {
  const ts = require(path.join(root, 'src/Shronchik.Web/node_modules/typescript'));
  const source = await fs.readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}

async function helperChecks() {
  const { prepareSource, deleteImportedSource, supportsSourceDeletion } = await loadModule('src/Shronchik.Web/src/sourceDeletion.ts');
  const makeFile = (bytes = 'original', name = 'photo.png', modified = 1234) => new File([bytes], name, { lastModified: modified });
  const setup = (original = makeFile()) => {
    const state = { file: original, removed: [], reads: [], denied: false, failDelete: false, replacement: false };
    const handle = {
      getFile: async () => { if (state.denied) throw new DOMException('Denied', 'NotAllowedError'); return state.file; },
      isSameEntry: async other => other === handle && !state.replacement,
    };
    state.directory = {
      getFileHandle: async (name, options) => {
        state.reads.push([name, options]);
        if (name !== original.name) throw new DOMException('Missing', 'NotFoundError');
        return handle;
      },
      removeEntry: async (...args) => {
        if (state.failDelete) throw new DOMException('Denied', 'NotAllowedError');
        state.removed.push(args);
      },
    };
    return state;
  };
  const neverCancelled = () => false;
  assert.equal(supportsSourceDeletion(), false);
  check('unsupported environments do not expose cleanup as available');

  const initial = makeFile();
  const safe = setup(makeFile());
  const prepared = await prepareSource(initial, safe.directory, neverCancelled);
  assert.notEqual(prepared.file, initial);
  assert.equal(await deleteImportedSource(prepared, neverCancelled), true);
  assert.deepEqual(safe.removed, [['photo.png']]);
  assert.ok(safe.reads.every(([name, options]) => name === 'photo.png' && options === undefined));
  check('matching source is the actual uploaded File and cleanup removes only its direct name without recursion');

  const wrongContent = setup(makeFile('modified'));
  await assert.rejects(prepareSource(initial, wrongContent.directory, neverCancelled), { code: 'source_changed' });
  assert.deepEqual(wrongContent.removed, []);
  const wrongMetadata = setup(makeFile('original', 'photo.png', 4321));
  await assert.rejects(prepareSource(initial, wrongMetadata.directory, neverCancelled), { code: 'source_changed' });
  check('same-name sources with changed contents or timestamps cannot enter a cleanup upload');

  const changed = setup(makeFile());
  const changedPrepared = await prepareSource(initial, changed.directory, neverCancelled);
  changed.file = makeFile('modified');
  await assert.rejects(deleteImportedSource(changedPrepared, neverCancelled), { code: 'source_changed' });
  assert.deepEqual(changed.removed, []);
  const replaced = setup(makeFile());
  const replacedPrepared = await prepareSource(initial, replaced.directory, neverCancelled);
  replaced.replacement = true;
  await assert.rejects(deleteImportedSource(replacedPrepared, neverCancelled), { code: 'source_changed' });
  assert.deepEqual(replaced.removed, []);
  check('content changes and replacement entries after upload preserve the current source');

  const cancelled = setup(makeFile());
  await assert.rejects(prepareSource(initial, cancelled.directory, () => true), { code: 'source_cancelled' });
  assert.deepEqual(cancelled.reads, []);
  const cancelPrepared = await prepareSource(initial, cancelled.directory, neverCancelled);
  assert.equal(await deleteImportedSource(cancelPrepared, () => true), false);
  assert.deepEqual(cancelled.removed, []);
  let cancellationChecks = 0;
  assert.equal(await deleteImportedSource(cancelPrepared, () => ++cancellationChecks >= 6), false);
  assert.deepEqual(cancelled.removed, []);
  check('cancellation before preparation and during cleanup never removes a source');

  const denied = setup(makeFile());
  denied.denied = true;
  await assert.rejects(prepareSource(initial, denied.directory, neverCancelled), { name: 'NotAllowedError' });
  denied.denied = false;
  const deniedPrepared = await prepareSource(initial, denied.directory, neverCancelled);
  denied.failDelete = true;
  await assert.rejects(deleteImportedSource(deniedPrepared, neverCancelled), { name: 'NotAllowedError' });
  assert.deepEqual(denied.removed, []);
  check('read and delete permission failures propagate without removing anything');

  const bytes = new Uint8Array(3 * 1024 * 1024 + 19).fill(73);
  let slices = 0, largestSlice = 0;
  const bounded = () => {
    const file = makeFile(bytes, 'large.webm');
    const slice = file.slice.bind(file);
    file.arrayBuffer = () => { throw new Error('Whole-file allocation is forbidden'); };
    file.slice = (start, end) => { slices++; largestSlice = Math.max(largestSlice, end - start); return slice(start, end); };
    return file;
  };
  const large = setup(bounded());
  const largePrepared = await prepareSource(bounded(), large.directory, neverCancelled);
  assert.equal(await deleteImportedSource(largePrepared, neverCancelled), true);
  assert.ok(slices >= 16 && largestSlice <= 1024 * 1024, { slices, largestSlice });
  check('large videos are verified in bounded chunks before upload and again before removal');
}

async function browserChecks() {
  const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);
  const { defaultSettings } = await loadModule('src/Shronchik.Web/src/types.ts');
  // Reuse the checked-in synthetic clip, without evaluating the other test suite.
  const videoFixtureSource = await fs.readFile(path.join(root, 'tests/media-features-smoke.cjs'), 'utf8');
  const fixture = /const clip = Buffer\.from\('([^']+)', 'base64'\)/.exec(videoFixtureSource);
  assert.ok(fixture, 'media features suite must provide its synthetic clip fixture');
  const clip = Buffer.from(fixture[1], 'base64');
  const imports = [], deleted = [], posterRequests = [], errors = [];
  let failName = '', delay = 20, posterFailures = 0;
  const item = (id, title = id, type = 'photo') => ({ id, type, title, description: '', rating: null, userRating: null,
    ratingCount: 0, views: 0, isFavorite: false, tags: [], size: type === 'video' ? clip.length : png.length,
    createdAt: '2026-11-08T00:00:00Z', mimeType: type === 'video' ? 'video/mp4' : 'image/png' });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const endpoint = url.pathname.slice('/api/v1'.length);
    const json = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    try {
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/test-record-delete') {
        const name = url.searchParams.get('name');
        const imported = imports.findLast(record => record.name === name);
        assert.ok(imported?.success, 'removal must follow a successful import response: ' + name);
        if (imported.media.type === 'video') assert.ok(imported.coverSaved, 'video removal must follow successful cover save');
        deleted.push(name); return json({});
      }
      if (url.pathname.startsWith('/api/v1/')) {
        if (endpoint === '/session' || endpoint === '/session/heartbeat') return json({ authenticated: true, locked: false,
          role: 'Admin', accountId: 'Admin', csrfToken: 'synthetic-token', weakPassword: false, mustChangePassword: false });
        if (endpoint === '/home') return json({ totalCount: imports.filter(record => record.success).length, totalBytes: png.length,
          categories: ['photo', 'video', 'gif'].map(type => ({ type, count: 0, totalBytes: 0 })) });
        if (endpoint === '/settings') return json({ ...defaultSettings, animationMs: 0, reduceMotion: 'on', lowDiskWarningGB: 0 });
        if (endpoint === '/tags') return json([]);
        if (endpoint === '/media') return json({ items: [], nextCursor: null, hasMore: false });
        if (endpoint.endsWith('/poster') && request.method === 'PUT') {
          for await (const chunk of request) { /* Drain the synthetic cover upload. */ }
          const id = endpoint.split('/')[2];
          const record = imports.find(record => record.media?.id === id);
          assert.ok(record, 'a video must be imported before its cover is saved');
          const poster = { id, success: posterFailures === 0 };
          posterRequests.push(poster);
          if (posterFailures > 0) { posterFailures--; return json({ code: 'request_failed' }, 500); }
          record.coverSaved = true;
          return json({ ...record.media, posterVersion: 'synthetic-cover' });
        }
        if (endpoint === '/imports') {
          const record = { name: url.searchParams.get('fileName'), success: false, bytes: 0 };
          imports.push(record);
          for await (const chunk of request) record.bytes += chunk.length;
          await pause(delay);
          if (record.name === failName) return json({ code: 'duplicate' }, 409);
          record.success = true;
          record.media = item('import-' + imports.length, url.searchParams.get('title'), /\.mp4$/i.test(record.name) ? 'video' : 'photo');
          return json(record.media, 201);
        }
        throw new Error('Unhandled synthetic API ' + endpoint);
      }
      const file = path.resolve(webRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(webRoot + path.sep)) { response.writeHead(403).end(); return; }
      const data = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }).end(data);
    } catch (error) {
      if (error.code !== 'ECONNRESET' && error.code !== 'ENOENT') errors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.SHRONCHIK_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const state = { entries: new Map(), removed: [], failDelete: false, pickerError: false, picks: [] };
      window.sourceMock = state;
      state.directory = {
        name: 'Synthetic originals', kind: 'directory',
        getFileHandle: async name => {
          const entry = state.entries.get(name);
          if (!entry) throw new DOMException('Missing', 'NotFoundError');
          return entry.handle;
        },
        removeEntry: async (name, options) => {
          if (options?.recursive) throw new Error('Recursive removal is forbidden');
          if (state.failDelete) throw new DOMException('Denied', 'NotAllowedError');
          await fetch('/test-record-delete?name=' + encodeURIComponent(name));
          state.removed.push(name); state.entries.delete(name);
        },
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      };
      window.showDirectoryPicker = async options => {
        state.picks.push(options);
        if (state.pickerError) throw new DOMException('Cancelled', 'AbortError');
        return state.directory;
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('.category-photo').click();
    const single = page.locator('.import-modal');
    const album = page.locator('.album-import-modal');
    const checkbox = dialog => dialog.getByRole('checkbox', { name: 'Удалять оригиналы после загрузки', exact: true });
    const choose = async (dialog, names) => {
      const input = dialog.locator('input[type="file"]').first();
      // Capture files before React clears the input, as a real directory handle would return them.
      await input.evaluate(element => element.addEventListener('change', async event => {
        const files = [...event.target.files];
        for (const original of files) {
          const file = new File([await original.arrayBuffer()], original.name, { type: original.type, lastModified: original.lastModified });
          const entry = { file };
          entry.handle = { kind: 'file', name: file.name, getFile: async () => entry.file,
            isSameEntry: async other => other === entry.handle };
          window.sourceMock.entries.set(file.name, entry);
        }
      }, { capture: true, once: true }));
      await input.setInputFiles(names.map(name => ({ name, mimeType: /\.mp4$/i.test(name) ? 'video/mp4' : 'image/png',
        buffer: /\.mp4$/i.test(name) ? clip : png })));
      await page.waitForFunction(names => names.every(name => window.sourceMock.entries.has(name)), names);
    };
    const openSingle = async names => {
      await page.getByRole('button', { name: 'Добавить файл', exact: true }).first().click();
      await choose(single, names);
    };
    const submitSingle = () => single.getByRole('button', { name: 'Добавить', exact: true }).click();

    await openSingle(['keep-default.png']);
    assert.equal(await checkbox(single).isChecked(), false);
    await submitSingle();
    await single.waitFor({ state: 'hidden' });
    assert.deepEqual(deleted, []);
    assert.equal(await page.evaluate(() => window.sourceMock.picks.length), 0);
    check('ordinary single-file upload preserves originals with cleanup off by default');

    await openSingle(['remove-success.png']);
    await checkbox(single).check();
    assert.deepEqual(await page.evaluate(() => window.sourceMock.picks.at(-1)), { id: 'shronchik-import-source', mode: 'readwrite' });
    await submitSingle();
    await single.waitFor({ state: 'hidden' });
    assert.ok(deleted.includes('remove-success.png'));
    check('single-file cleanup requests folder write access and removes only after successful import');

    await openSingle(['duplicate.png']);
    await checkbox(single).check();
    failName = 'duplicate.png';
    await submitSingle();
    await single.getByRole('alert').waitFor();
    assert.ok(!deleted.includes('duplicate.png'));
    await single.locator('.modal-actions').getByRole('button', { name: 'Отмена', exact: true }).click();
    failName = '';
    check('duplicate import failure preserves its original');

    await openSingle(['cleanup-retry.png']);
    await checkbox(single).check();
    await page.evaluate(() => { window.sourceMock.failDelete = true; });
    const beforeRetry = imports.length;
    await submitSingle();
    await single.getByRole('alert').waitFor();
    assert.equal(imports.length - beforeRetry, 1);
    assert.ok(!deleted.includes('cleanup-retry.png'));
    await page.evaluate(() => { window.sourceMock.failDelete = false; });
    await single.locator('.modal-actions .primary-button').click();
    await single.waitFor({ state: 'hidden' });
    assert.equal(imports.length - beforeRetry, 1);
    assert.ok(deleted.includes('cleanup-retry.png'));
    check('retry after cleanup failure removes the saved original without uploading a duplicate');

    await openSingle(['wrong-folder.png']);
    await checkbox(single).check();
    await page.evaluate(() => { window.sourceMock.entries.delete('wrong-folder.png'); });
    const beforeWrongFolder = imports.length;
    await submitSingle();
    await single.getByRole('alert').waitFor();
    assert.equal(imports.length, beforeWrongFolder);
    assert.ok(!deleted.includes('wrong-folder.png'));
    await single.locator('.modal-actions').getByRole('button', { name: 'Отмена', exact: true }).click();
    check('a wrong source folder prevents upload and cleanup without touching other files');

    await page.locator('.brand').click();
    await page.locator('.category-video').click();
    await openSingle(['video-cover-retry.mp4']);
    await single.getByLabel('Загрузить свою обложку', { exact: true }).setInputFiles({ name: 'synthetic-cover.png', mimeType: 'image/png', buffer: png });
    await single.locator('.poster-picker-custom').waitFor();
    await checkbox(single).check();
    const output = path.join(root, '.cache/source-deletion-smoke');
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'single-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await single.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(output, 'single-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const beforeVideo = imports.length;
    const beforeCover = posterRequests.length;
    posterFailures = 1;
    await submitSingle();
    await single.getByRole('alert').waitFor();
    assert.match(await single.getByRole('alert').textContent(), /Не удалось сохранить обложку/);
    assert.equal(imports.length - beforeVideo, 1);
    assert.equal(posterRequests.length - beforeCover, 1);
    assert.equal(posterRequests.at(-1).success, false);
    assert.ok(!deleted.includes('video-cover-retry.mp4'));
    assert.ok(await page.evaluate(() => window.sourceMock.entries.has('video-cover-retry.mp4')));
    await single.locator('.modal-actions .primary-button').click();
    await single.waitFor({ state: 'hidden' });
    assert.equal(imports.length - beforeVideo, 1);
    assert.equal(posterRequests.length - beforeCover, 2);
    assert.equal(posterRequests.at(-1).success, true);
    assert.ok(deleted.includes('video-cover-retry.mp4'));
    check('video source survives failed cover save and is removed after cover retry without a second import');

    await page.locator('.brand').click();
    await page.locator('.category-photo').click();
    await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).click();
    await choose(album, ['album-cleanup-retry.png']);
    await checkbox(album).check();
    await page.evaluate(() => { window.sourceMock.failDelete = true; });
    const beforeAlbumRetry = imports.length;
    await album.getByRole('button', { name: 'Загрузить фотографии', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.album-import-photo[data-status="done"][data-source-error="true"]'));
    assert.equal(imports.length - beforeAlbumRetry, 1);
    await page.evaluate(() => { window.sourceMock.failDelete = false; });
    await album.getByRole('button', { name: 'Повторить удаление', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.album-import-photo[data-source-error="true"]'));
    assert.equal(imports.length - beforeAlbumRetry, 1);
    assert.ok(deleted.includes('album-cleanup-retry.png'));
    await album.getByRole('button', { name: 'Готово', exact: true }).click();
    check('album cleanup failure remains imported and cleanup retry sends no second upload');

    await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).click();
    await choose(album, ['album-success.png', 'album-duplicate.png']);
    await checkbox(album).check();
    failName = 'album-duplicate.png';
    await album.getByRole('button', { name: 'Загрузить фотографии', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.album-import-photo[data-status="done"]').length === 1 &&
      document.querySelectorAll('.album-import-photo[data-status="error"]').length === 1);
    assert.ok(deleted.includes('album-success.png'));
    assert.ok(!deleted.includes('album-duplicate.png'));
    await album.locator('.modal-actions').getByRole('button', { name: 'Закрыть', exact: true }).click();
    failName = '';
    check('partial album success removes successful sources and preserves failed sources');

    await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).click();
    await choose(album, ['stop-1.png', 'stop-2.png']);
    await checkbox(album).check();
    delay = 600;
    const beforeStop = imports.length;
    await album.getByRole('button', { name: 'Загрузить фотографии', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.album-import-photo[data-status="uploading"]'));
    await album.getByRole('button', { name: 'Остановить', exact: true }).click();
    await pause(700);
    assert.ok(imports.length - beforeStop <= 1);
    assert.ok(!deleted.some(name => name.startsWith('stop-')));
    await album.locator('.modal-actions').getByRole('button', { name: 'Закрыть', exact: true }).click();
    check('stopping an album preserves the in-flight and queued sources');

    await openSingle(['picker-cancel.png']);
    await page.evaluate(() => { window.sourceMock.pickerError = true; });
    await checkbox(single).click();
    await page.waitForFunction(() => !document.querySelector('.source-deletion-option input[type="checkbox"]').checked);
    assert.equal(await checkbox(single).isChecked(), false);
    await single.locator('.modal-actions').getByRole('button', { name: 'Отмена', exact: true }).click();
    check('cancelling folder access leaves cleanup disabled');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  await helperChecks();
  if (process.env.SHRONCHIK_HELPER_ONLY !== '1') await browserChecks();
  console.log(`Source deletion smoke: ${checks} scenarios passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
