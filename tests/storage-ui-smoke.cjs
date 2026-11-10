// Focused storage UI regression checks. Uses synthetic API data only.
// Requires a built UI and SHRONCHIK_PLAYWRIGHT pointing to Playwright.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'src/Shronchik.Server/wwwroot');
const screenshots = path.join(root, '.cache/storage-ui-smoke');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
const check = label => { checks++; console.log('PASS ' + label); };

async function main() {
  await fs.mkdir(screenshots, { recursive: true });
  let activeStream;
  let streamStarted;
  let truncateStream = false;
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/api/v1/storage/move') {
        assert.equal(req.headers.accept, 'application/x-ndjson');
        assert.equal(req.headers['x-csrf-token'], 'synthetic-token');
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        activeStream = res;
        res.write(JSON.stringify({ type: 'progress', phase: 'preparing', percent: 0, bytesCompleted: 0, totalBytes: 1000, filesCompleted: 0, totalFiles: 4 }) + '\n');
        streamStarted.resolve();
        if (truncateStream) res.end();
        return;
      }
      if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      const file = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      assert.ok(file.startsWith(webRoot + path.sep));
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.SHRONCHIK_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const browserErrors = [];
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => browserErrors.push(error.message));
      let role = 'Admin', libraryRoot = 'C:\\Library', moveRequests = 0, connectRequests = 0, pickerRequests = 0;
      let moveTarget = 'D:\\FreshLibrary';
      const pickerGate = deferred();
      streamStarted = deferred();
      truncateStream = false;
      const storage = () => ({ mediaRoot: libraryRoot, databaseRoot: libraryRoot + '\\db', freeBytes: 256 * 1024 ** 3, available: true });
      const session = () => ({ authenticated: role !== null, locked: false, role, accountId: role === 'Admin' ? 'Admin' : role ? 'synthetic.friend' : null,
        csrfToken: role ? 'synthetic-token' : null, weakPassword: false, mustChangePassword: false });
      await page.route('**/api/v1/**', async route => {
        const url = new URL(route.request().url());
        const endpoint = url.pathname.slice('/api/v1'.length);
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (endpoint === '/session' || endpoint === '/session/heartbeat') return json(session());
        if (endpoint === '/home') return json({ totalCount: 0, totalBytes: 0, categories: ['photo', 'video', 'gif'].map(type => ({ type, count: 0, totalBytes: 0 })) });
        if (endpoint === '/tags') return json([]);
        if (endpoint === '/accounts') return json({ items: [] });
        if (endpoint === '/settings') return json({ language: 'ru', animationMs: 0, reduceMotion: 'on' });
        if (endpoint === '/storage' || endpoint === '/storage/check') return json(storage());
        if (endpoint === '/storage/folders/pick') {
          pickerRequests++;
          assert.equal(route.request().method(), 'POST');
          assert.equal(route.request().headers()['x-csrf-token'], 'synthetic-token');
          assert.deepEqual(route.request().postDataJSON(), { path: 'C:\\' });
          if (pickerRequests === 1) return json(await pickerGate.promise);
          return json({ path: 'D:\\FreshLibrary' });
        }
        if (endpoint === '/storage/folders') {
          const destination = url.searchParams.get('path');
          if (!destination) return json({ path: null, parentPath: null, folders: [{ name: 'C:\\', path: 'C:\\' }, { name: 'D:\\', path: 'D:\\' }], isLibrary: false });
          if (destination === 'D:\\') return json({ path: destination, parentPath: null, folders: [{ name: 'Archive', path: 'D:\\Archive' }], isLibrary: false });
          return json({ path: destination, parentPath: destination.startsWith('C:') ? 'C:\\' : 'D:\\', folders: [], isLibrary: destination === 'D:\\Archive' || destination === libraryRoot });
        }
        if (endpoint === '/storage/move') {
          moveRequests++;
          const data = route.request().postDataJSON();
          assert.deepEqual(data, { path: moveTarget });
          return route.continue();
        }
        if (endpoint === '/storage/connect') {
          connectRequests++;
          const data = route.request().postDataJSON();
          assert.equal(data.path, 'D:\\Archive');
          if (data.password !== 'selected-library-password') return json({ code: 'invalid_credentials' }, 401);
          role = null;
          return json({ ...storage(), mediaRoot: data.path, databaseRoot: data.path + '\\db' });
        }
        throw new Error('Unhandled synthetic storage endpoint ' + endpoint);
      });

      await page.goto(origin);
      await page.locator('.account-button').click();
      await page.getByRole('button', { name: 'Настройки', exact: true }).click();
      await page.locator('.settings-nav').getByRole('button', { name: 'Хранилище', exact: true }).click();
      const panel = page.locator('.settings-storage-status');
      await panel.locator('dl').waitFor();
      assert.equal(await panel.getByRole('button', { name: 'Перенести БД', exact: true }).count(), 1);
      assert.equal(await panel.getByRole('button', { name: 'Подключить БД', exact: true }).count(), 1);
      await page.screenshot({ path: path.join(screenshots, `storage-${width}.png`), fullPage: true });

      await panel.getByRole('button', { name: 'Перенести БД', exact: true }).click();
      const dialog = page.locator('.storage-folder-dialog');
      await dialog.getByText('Найдена библиотека', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'На уровень выше', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.storage-path-form input')?.value === 'C:\\');
      await dialog.getByRole('button', { name: 'Открыть', exact: true }).click();
      await dialog.getByRole('status').filter({ hasText: 'окне Windows' }).waitFor();
      await dialog.getByRole('button', { name: 'Открыть', exact: true }).evaluate(button => { button.click(); button.click(); });
      assert.equal(pickerRequests, 1);
      assert.equal(await dialog.getByLabel('Папка на сервере', { exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 1);
      pickerGate.resolve({ path: null });
      await page.waitForFunction(() => !document.querySelector('.storage-path-form input')?.disabled);
      assert.equal(await dialog.getByLabel('Папка на сервере', { exact: true }).inputValue(), 'C:\\');
      assert.equal(await dialog.getByRole('alert').count(), 0);
      await dialog.getByRole('button', { name: 'Открыть', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.storage-path-form input')?.value === 'D:\\FreshLibrary');
      assert.equal(pickerRequests, 2);
      check(`Open requests the native chooser, prevents duplicates and preserves the path on cancellation (${width}px)`);
      await dialog.getByRole('button', { name: 'Выбрать папку', exact: true }).click();
      assert.deepEqual(await dialog.locator('.storage-selected-path').allTextContents(), ['C:\\Library', 'D:\\FreshLibrary']);
      await page.screenshot({ path: path.join(screenshots, `move-confirm-${width}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await dialog.getByRole('button', { name: 'Перенести сюда', exact: true }).click();
      await streamStarted.promise;
      await page.waitForFunction(() => document.querySelector('.storage-folder-dialog button[type="submit"]')?.disabled);
      await dialog.getByRole('progressbar').waitFor();
      assert.equal(await dialog.getByRole('progressbar').getAttribute('value'), '0');
      await dialog.locator('form').evaluate(form => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 1);
      assert.equal(await dialog.getByRole('button', { name: 'Назад', exact: true }).isDisabled(), true);
      assert.equal(moveRequests, 1);
      const progressLine = JSON.stringify({ type: 'progress', phase: 'copying', percent: 24, bytesCompleted: 340, totalBytes: 1000, filesCompleted: 1, totalFiles: 4, detail: 'Копирование' }) + '\n';
      const progressBytes = Buffer.from(progressLine);
      const split = progressBytes.indexOf(Buffer.from('К')) + 1;
      activeStream.write(progressBytes.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(await dialog.getByRole('progressbar').getAttribute('value'), '0');
      activeStream.write(progressBytes.subarray(split));
      await page.waitForFunction(() => document.querySelector('.storage-move-progress progress')?.value === 24);
      await dialog.getByText('Копирование файлов', { exact: true }).waitFor();
      activeStream.write(JSON.stringify({ type: 'progress', phase: 'verifying', percent: 82, bytesCompleted: 480, totalBytes: 1000, filesCompleted: 2, totalFiles: 4 }) + '\n');
      await page.waitForFunction(() => document.querySelector('.storage-move-progress progress')?.value === 82);
      await dialog.getByText('Проверка скопированных данных', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(screenshots, `move-progress-${width}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      activeStream.write(JSON.stringify({ type: 'progress', phase: 'completed', percent: 100, bytesCompleted: 1000, totalBytes: 1000, filesCompleted: 4, totalFiles: 4 }) + '\n');
      await page.waitForFunction(() => document.querySelector('.storage-move-progress progress')?.value === 99);
      libraryRoot = 'D:\\FreshLibrary';
      activeStream.end(JSON.stringify({ type: 'complete', storage: { ...storage(), sourceRetained: true } }) + '\n');
      await dialog.waitFor({ state: 'hidden' });
      await panel.getByRole('status').filter({ hasText: 'Исходная папка очищена не полностью' }).waitFor();
      assert.ok((await panel.locator('dd').allTextContents()).includes('D:\\FreshLibrary'));
      check(`move streams real percentages across partial UTF8 chunks, guards submits and waits for completion (${width}px)`);

      truncateStream = true;
      streamStarted = deferred();
      moveTarget = 'D:\\RetryLibrary';
      await panel.getByRole('button', { name: 'Перенести БД', exact: true }).click();
      await dialog.getByText('Найдена библиотека', { exact: true }).waitFor();
      await dialog.getByLabel('Папка на сервере', { exact: true }).fill(moveTarget);
      await dialog.getByRole('button', { name: 'Выбрать папку', exact: true }).click();
      await dialog.getByRole('button', { name: 'Перенести сюда', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: 'Связь с сервером прервалась' }).waitFor();
      assert.equal(await dialog.getByRole('progressbar').count(), 0);
      assert.ok((await panel.locator('dd').allTextContents()).includes('D:\\FreshLibrary'));
      await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
      check(`an incomplete move stream keeps the dialog open and never reports success (${width}px)`);

      await panel.getByRole('button', { name: 'Подключить БД', exact: true }).click();
      await dialog.getByText('Найдена библиотека', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Диски', exact: true }).click();
      await dialog.locator('.storage-folder-list').getByRole('button', { name: 'D:\\', exact: true }).click();
      await dialog.locator('.storage-folder-list').getByRole('button', { name: 'Archive', exact: true }).click();
      await dialog.getByText('Найдена библиотека', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Выбрать папку', exact: true }).click();
      assert.equal(await dialog.getByRole('button', { name: 'Подключить', exact: true }).isDisabled(), true);
      await dialog.getByLabel('Пароль Admin выбранной БД', { exact: true }).fill('wrong-password');
      await dialog.getByRole('button', { name: 'Подключить', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: 'Неверный пароль Admin' }).waitFor();
      assert.equal(await dialog.locator('.storage-selected-path').innerText(), 'D:\\Archive');
      assert.equal(connectRequests, 1);
      await page.screenshot({ path: path.join(screenshots, `connect-error-${width}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await dialog.getByLabel('Пароль Admin выбранной БД', { exact: true }).fill('selected-library-password');
      await dialog.getByRole('button', { name: 'Подключить', exact: true }).click();
      await page.locator('.auth-card').waitFor();
      assert.equal(connectRequests, 2);
      check(`folder browser finds an existing library, preserves wrong-password errors, then reloads for sign-in (${width}px)`);

      role = 'User';
      await page.reload();
      await page.locator('.account-button').click();
      await page.getByRole('button', { name: 'Настройки', exact: true }).click();
      assert.equal(await page.locator('.settings-nav').getByRole('button', { name: 'Хранилище', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Перенести БД', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Подключить БД', exact: true }).count(), 0);
      check(`database controls are available only to Admin (${width}px)`);
      await page.close();
    }
    assert.deepEqual(browserErrors, []);
    console.log(`Storage UI smoke: ${checks} scenarios passed. Screenshots: ${screenshots}`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
