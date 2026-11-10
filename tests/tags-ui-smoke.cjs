// Tag localization and selection regressions using synthetic API responses only.
// Build the UI first and set SHRONCHIK_PLAYWRIGHT to an installed Playwright package.
// Set SHRONCHIK_WEB_ROOT to .tools/hosting/server/wwwroot to check the published UI.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);

const root = path.resolve(__dirname, '..');
const webRoot = path.resolve(process.env.SHRONCHIK_WEB_ROOT ?? path.join(root, 'src/Shronchik.Server/wwwroot'));
const output = path.join(root, '.cache/tags-ui-smoke');
const expected = [
  ['asia', 'Asia'], ['black', 'Black'], ['white', 'White'], ['latina', 'Latina'], ['european', 'European'],
  ['dark-hair', 'Dark hair'], ['light-hair', 'Light hair'],
  ['with-makeup', 'With makeup'], ['without-makeup', 'Without makeup'],
  ['with-tattoos', 'With tattoos'], ['without-tattoos', 'Without tattoos'],
];
const groups = { ru: ['Раса', 'Прическа', 'Макияж', 'Тату'], en: ['Race', 'Hairstyle', 'Makeup', 'Tattoos'] };
const labels = expected.map(([, label]) => label);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
const media = { id: '00000000-0000-0000-0000-000000000001', type: 'photo', title: 'Synthetic tag sample',
  description: '', rating: null, views: 0, isFavorite: false, size: png.length,
  createdAt: '2026-11-08T00:00:00Z', mimeType: 'image/png', tags: ['asia', 'dark-hair', 'with-tattoos'] };
let language = 'ru', checks = 0, imports = 0;
const errors = [];
const check = label => { checks++; console.log('PASS ' + label); };

async function main() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const endpoint = url.pathname.slice('/api/v1'.length);
      const json = value => { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); };
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname.startsWith('/api/v1/')) {
        if (endpoint === '/session' || endpoint === '/session/heartbeat') return json({ authenticated: true,
          locked: false, role: 'Admin', accountId: 'Admin', csrfToken: 'synthetic-token',
          weakPassword: false, mustChangePassword: false });
        if (endpoint === '/home') return json({ totalCount: 1, totalBytes: png.length,
          categories: ['photo', 'video', 'gif'].map(type => ({ type, count: type === 'photo' ? 1 : 0, totalBytes: png.length })) });
        if (endpoint === '/settings') return json({ language, gridColumns: 3, sidebarExpanded: true,
          showRelatedBelow: false, queryDebounceMs: 0, animationMs: 0, reduceMotion: 'on' });
        // An obsolete tag must not return to the UI even if a stale response includes it.
        if (endpoint === '/tags') return json([...expected.map(([id]) => id), 'studio']);
        if (endpoint === '/media') return json({ items: [media], nextCursor: null, hasMore: false });
        if (endpoint.endsWith('/stream')) { response.writeHead(200, { 'Content-Type': 'image/png' }).end(png); return; }
        if (endpoint === '/imports') { imports++; return json(media); }
        throw new Error('Unhandled synthetic tag endpoint ' + endpoint);
      }
      const file = path.resolve(webRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(webRoot + path.sep)) { response.writeHead(403).end(); return; }
      const data = await fs.readFile(file);
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      response.writeHead(200, { 'Content-Type': contentType }).end(data);
    } catch (error) {
      errors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    await fs.mkdir(output, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.SHRONCHIK_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    for (language of ['ru', 'en']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin);
        await page.waitForFunction(value => document.documentElement.lang === value, language);
        await page.locator('.category-photo').click();
        await page.locator('.filter-tag').last().waitFor();
        assert.deepEqual(await page.locator('.filter-tag-group h4').allTextContents(), groups[language]);
        assert.deepEqual(await page.locator('.filter-tag > span:first-child').allTextContents(), labels);
        assert.deepEqual(await page.locator('.thumbnail-tag').allTextContents(), ['#Asia', '#Dark hair', '#With tattoos']);
        await page.screenshot({ path: path.join(output, `tags-${language}-filters.png`) });
        check(`${language}: filters show four localized groups, exactly 11 English tags, and English thumbnail labels`);

        const tagSearch = page.locator('.tag-search input');
        for (const query of ['Dark', 'Темные волосы']) {
          await tagSearch.fill(query);
          assert.deepEqual(await page.locator('.filter-tag > span:first-child').allTextContents(), ['Dark hair']);
        }
        await tagSearch.fill('');
        const asia = page.locator('.filter-tag').filter({ hasText: /^Asia$/ });
        const filteredResponse = (include, exclude) => page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/v1/media' && url.searchParams.get('includeTags') === include
            && url.searchParams.get('excludeTags') === exclude;
        });
        await Promise.all([filteredResponse('asia', ''), asia.click()]);
        assert.match(await asia.getAttribute('class'), /included/);
        await Promise.all([filteredResponse('', 'asia'), asia.click()]);
        assert.match(await asia.getAttribute('class'), /excluded/);
        await asia.click();
        assert.doesNotMatch(await asia.getAttribute('class'), /included|excluded/);
        check(`${language}: English and Russian alias searches match; include/exclude filters send stable IDs`);

        await page.locator('.gallery-tools').getByRole('button', { name: language === 'ru' ? 'Добавить файл' : 'Add a file', exact: true }).click();
        const modal = page.locator('.import-modal');
        const picker = modal.locator('.tag-picker');
        await picker.waitFor();
        assert.deepEqual(await picker.locator('.tag-picker-options h4').allTextContents(), groups[language]);
        assert.deepEqual(await picker.locator('.tag-picker-options button').allTextContents(), labels);
        assert.equal(await picker.getByRole('button', { name: /^(Добавить|Add)$/ }).count(), 0);
        const pickerSearch = picker.getByRole('searchbox', { name: language === 'ru' ? 'Найти тег' : 'Find a tag', exact: true });
        for (const query of ['Dark', 'Темные волосы']) {
          await pickerSearch.fill(query);
          assert.deepEqual(await picker.locator('.tag-picker-options button').allTextContents(), ['Dark hair']);
        }
        await picker.getByRole('button', { name: 'Dark hair', exact: true }).click();
        assert.deepEqual(await picker.locator('.tag-picker-selected button').allTextContents(), ['Dark hair ×']);
        await pickerSearch.fill('arbitrary custom tag');
        await pickerSearch.press('Enter');
        assert.equal(await picker.locator('.tag-picker-options button').count(), 0);
        assert.deepEqual(await picker.locator('.tag-picker-selected button').allTextContents(), ['Dark hair ×']);
        assert.equal(imports, 0);
        await pickerSearch.fill('');
        await page.screenshot({ path: path.join(output, `tags-${language}-import.png`) });
        check(`${language}: importer localizes only group headings, searches aliases and prevents arbitrary tag creation`);
        await modal.getByRole('button', { name: language === 'ru' ? 'Закрыть' : 'Close', exact: true }).first().click();
        await modal.waitFor({ state: 'hidden' });

        await page.locator('.media-card').click();
        const player = page.locator('.player-overlay[open]');
        await player.waitFor();
        assert.deepEqual(await player.locator('.media-tags button').allTextContents(), ['#Asia', '#Dark hair', '#With tattoos']);
        await player.locator('.media-tags button').getByText('#Asia', { exact: true }).click();
        await player.waitFor({ state: 'hidden' });
        assert.deepEqual(await page.locator('.filter-tag.included > span:first-child').allTextContents(), ['Asia']);
        assert.equal(await page.locator('.filter-tag.excluded').count(), 0);
        check(`${language}: player labels stay English and clicking a tag applies its canonical filter ID`);
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    console.log(`Tags UI smoke: ${checks} scenarios passed.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
