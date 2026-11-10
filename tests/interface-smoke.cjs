// Interface regressions with synthetic accounts, preferences and ratings only.
// Build the UI first, then set SHRONCHIK_PLAYWRIGHT to an installed package.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'src/Shronchik.Server/wwwroot');
const output = path.join(root, '.cache/interface-smoke');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
const mediaId = '00000000-0000-0000-0000-000000000001';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
const check = label => { checks++; console.log('PASS ' + label); };

async function main() {
  const ts = require(path.join(root, 'src/Shronchik.Web/node_modules/typescript'));
  const source = await fs.readFile(path.join(root, 'src/Shronchik.Web/src/types.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { defaultSettings } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const preferences = new Map();
  const votes = new Map([['first.friend', 1000], ['second.friend', 3000]]);
  const patches = [], ratingRequests = [], errors = [];
  let accountId = null, weakPassword = false;
  let patchGate = null, heldPatch = null, rejectNextPatch = false, activePatches = 0, maximumActivePatches = 0;
  const settings = () => {
    if (!preferences.has(accountId)) preferences.set(accountId, { ...defaultSettings, reduceMotion: 'off', showRelatedBelow: false });
    return preferences.get(accountId);
  };
  const session = () => ({ authenticated: accountId !== null, locked: false, role: accountId === 'Admin' ? 'Admin' : accountId ? 'User' : null,
    accountId, csrfToken: accountId ? 'synthetic-token' : null, weakPassword, mustChangePassword: false });
  const media = () => ({ id: mediaId, type: 'photo', title: 'Synthetic landscape', description: '',
    rating: votes.size ? Math.round([...votes.values()].reduce((sum, vote) => sum + vote, 0) / votes.size) : null,
    userRating: votes.get(accountId) ?? null, ratingCount: votes.size, views: 0, isFavorite: false,
    size: png.length, tags: [], createdAt: '2026-11-08T00:00:00Z', mimeType: 'image/png' });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const endpoint = url.pathname.slice('/api/v1'.length);
      const json = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
      const body = async () => { let data = ''; for await (const chunk of request) data += chunk; return data ? JSON.parse(data) : {}; };
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname.startsWith('/api/v1/')) {
        if (endpoint === '/session' || endpoint === '/session/heartbeat') return json(session());
        if (endpoint === '/auth/login') { accountId = (await body()).username; return json(session()); }
        if (endpoint === '/auth/logout') { accountId = null; return json(session()); }
        if (endpoint === '/home') return json({ totalCount: 1, totalBytes: png.length,
          categories: ['photo', 'video', 'gif'].map(type => ({ type, count: type === 'photo' ? 1 : 0, totalBytes: type === 'photo' ? png.length : 0 })) });
        if (endpoint === '/tags') return json([]);
        if (endpoint === '/settings') return json(settings());
        if (endpoint === '/accounts') return json({ items: [] });
        if (endpoint === '/storage') return json({ mediaRoot: 'C:\\SyntheticLibrary', databaseRoot: 'C:\\SyntheticLibrary\\db',
          freeBytes: 256 * 1024 ** 3, available: true });
        if (endpoint === '/settings/ui' || endpoint === '/settings/admin') {
          activePatches++; maximumActivePatches = Math.max(maximumActivePatches, activePatches);
          try {
            const patch = await body(); patches.push({ accountId, endpoint, patch });
            assert.equal(request.headers['x-csrf-token'], 'synthetic-token');
            const administrative = endpoint === '/settings/admin';
            if (administrative) assert.equal(accountId, 'Admin');
            for (const key of Object.keys(patch)) assert.equal(['thumbnailCandidates', 'trashRetentionDays', 'lowDiskWarningGB'].includes(key), administrative,
              `Wrong settings scope for ${key}`);
            const gate = patchGate; patchGate = null;
            if (gate) await gate.promise;
            if (rejectNextPatch) { rejectNextPatch = false; return json({ code: 'synthetic_save_failure' }, 503); }
            preferences.set(accountId, { ...settings(), ...patch }); return json(settings());
          } finally { activePatches--; }
        }
        if (endpoint === '/media') return json({ items: url.searchParams.get('type') === 'photo' ? [media()] : [], nextCursor: null, hasMore: false });
        if (endpoint.endsWith('/opened')) { response.writeHead(204).end(); return; }
        if (endpoint.endsWith('/stream')) { response.writeHead(200, { 'Content-Type': 'image/png' }).end(png); return; }
        if (endpoint.endsWith('/rating')) {
          const patch = await body(); ratingRequests.push({ accountId, ...patch });
          assert.notEqual(accountId, 'Admin');
          if (patch.rating === null) votes.delete(accountId); else votes.set(accountId, patch.rating);
          return json(media());
        }
        throw new Error('Unhandled synthetic interface endpoint ' + endpoint);
      }
      const file = path.resolve(webRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(webRoot + path.sep)) { response.writeHead(403).end(); return; }
      const data = await fs.readFile(file);
      const type = path.extname(file) === '.js' ? 'text/javascript' : path.extname(file) === '.css' ? 'text/css' : 'text/html';
      response.writeHead(200, { 'Content-Type': type }).end(data);
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    await fs.mkdir(output, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.SHRONCHIK_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    for (const [width, height] of [[1440, 1000], [390, 844], [1440, 1500]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.auth-footer').getByText('Shronchik by kentakle', { exact: true }).waitFor();
      const layout = await page.locator('.auth-footer').evaluate(element => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: innerHeight, documentHeight: document.documentElement.scrollHeight,
          contentBottom: document.querySelector('.auth-card').getBoundingClientRect().bottom };
      });
      assert.ok(layout.top >= layout.contentBottom, `Footer overlaps login card at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.documentHeight - layout.bottom <= 50, `Footer is not at the page bottom: ${JSON.stringify(layout)}`);
      assert.ok(layout.documentHeight >= layout.height);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(output, `auth-${width}-${height}.png`), fullPage: true });
    }
    check('sign-in footer stays at the page bottom without overlapping content on phone and tall desktop screens');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const settlePage = () => page.waitForFunction(() => {
      const element = document.querySelector('.page-transition');
      return element?.dataset.state === 'entering' && getComputedStyle(element).opacity === '1';
    });
    const signIn = async username => {
      await page.locator('#login-username').fill(username);
      await page.locator('#login-password').fill('synthetic-password');
      await page.locator('.auth-submit').click();
      await page.locator('.category-photo').waitFor();
      await settlePage();
    };
    const signOut = async () => {
      await page.locator('.account-button').click();
      await page.getByRole('button', { name: 'Выйти', exact: true }).click();
      await page.locator('#login-username').waitFor();
    };
    const openSettings = async () => {
      assert.equal(await page.locator('.header-actions > button[aria-label="Настройки"]').count(), 0);
      await page.locator('.account-button').click();
      await page.locator('.account-menu').getByRole('button', { name: 'Настройки', exact: true }).click();
      await page.locator('#setting-theme').waitFor();
      await page.locator('.modal').evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
    };
    const closeSettings = async () => {
      await page.locator('.modal').getByRole('button', { name: 'Закрыть', exact: true }).first().click();
      await page.locator('.expanded-settings').waitFor({ state: 'hidden' });
    };
    const settingsSection = id => page.locator('#settings-section-' + id);
    const settingsNav = label => page.locator('.settings-nav').getByRole('button', { name: label, exact: true });
    const waitForSaved = () => page.locator('.settings-autosave').getByText('Сохранено', { exact: true }).waitFor();
    const waitUntil = async (predicate, message) => {
      const deadline = Date.now() + 12000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await page.waitForTimeout(20);
      }
    };
    const waitForAnchor = id => page.waitForFunction(id => {
      const pane = document.querySelector('.settings-content');
      const target = document.getElementById('settings-section-' + id);
      const top = Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight,
        pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top));
      return Math.abs(pane.scrollTop - top) <= 3;
    }, id);
    const settingsGeometry = () => page.locator('.settings-content').evaluate(pane => ({
      navTop: document.querySelector('.settings-nav').getBoundingClientRect().top,
      headingTop: pane.closest('dialog').querySelector('.modal-heading').getBoundingClientRect().top,
      dialogScroll: pane.closest('dialog').scrollTop, pageScroll: window.scrollY,
      paneTop: pane.getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > innerWidth + 1 || pane.scrollWidth > pane.clientWidth + 1,
    }));
    await signIn('first.friend');
    await page.locator('.home-footer').getByText('Shronchik by kentakle', { exact: true }).waitFor();
    await openSettings();
    assert.deepEqual(await page.locator('.settings-content > .settings-section').evaluateAll(elements => elements.map(element => element.id)),
      ['appearance', 'gallery', 'player', 'feed', 'hotkeys', 'security'].map(id => 'settings-section-' + id));
    assert.equal(await page.locator('.settings-content form form').count(), 0);
    assert.equal(await page.locator('.settings-modal').getByRole('button', { name: 'Сохранить', exact: true }).count(), 0);
    const navSpacing = await page.locator('.settings-nav').evaluate(nav => {
      const box = nav.getBoundingClientRect();
      return { width: box.width, clearance: Math.min(...[...nav.querySelectorAll('button')].map(button => box.right - button.getBoundingClientRect().right)) };
    });
    assert.ok(navSpacing.width >= 185 && navSpacing.clearance >= 15, `Settings menu has comfortable width and divider padding: ${JSON.stringify(navSpacing)}`);
    const fixedDesktop = await settingsGeometry();
    await page.screenshot({ path: path.join(output, 'settings-desktop-appearance.png') });
    const smooth = await page.evaluate(async () => {
      const pane = document.querySelector('.settings-content');
      const start = pane.scrollTop, samples = [];
      const target = Math.min(pane.scrollHeight - pane.clientHeight,
        start + document.getElementById('settings-section-gallery').getBoundingClientRect().top - pane.getBoundingClientRect().top);
      const started = performance.now();
      [...document.querySelectorAll('.settings-nav button')].find(button => button.textContent === 'Галерея и поиск').click();
      while (performance.now() - started < 400) {
        await new Promise(requestAnimationFrame);
        samples.push(pane.scrollTop);
      }
      return { start, samples, end: pane.scrollTop, target };
    });
    assert.ok(smooth.end > smooth.start + 100);
    assert.ok(smooth.samples.some(top => top > smooth.start + 1 && top < smooth.end - 1), 'navigation has intermediate animation frames');
    assert.ok(Math.abs(smooth.end - smooth.target) <= 3, 'anchor animation finishes within 400ms');
    await waitForAnchor('gallery');
    assert.equal(await settingsNav('Галерея и поиск').getAttribute('aria-current'), 'location');
    assert.deepEqual(await settingsGeometry(), fixedDesktop);
    await page.screenshot({ path: path.join(output, 'settings-desktop-gallery.png') });
    await page.evaluate(async () => {
      const buttons = [...document.querySelectorAll('.settings-nav button')];
      buttons.find(button => button.textContent === 'Безопасность').click();
      await new Promise(resolve => setTimeout(resolve, 55));
      buttons.find(button => button.textContent === 'Галерея и поиск').click();
    });
    await waitForAnchor('gallery');
    await page.waitForTimeout(280);
    await waitForAnchor('gallery');
    await page.evaluate(async () => {
      const pane = document.querySelector('.settings-content');
      [...document.querySelectorAll('.settings-nav button')].find(button => button.textContent === 'Безопасность').click();
      await new Promise(resolve => setTimeout(resolve, 55));
      pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
      const target = document.getElementById('settings-section-player');
      pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    });
    await page.waitForTimeout(300);
    await waitForAnchor('player');
    assert.equal(await settingsNav('Воспроизведение').getAttribute('aria-current'), 'location');
    check('settings share one scroll pane, keep navigation and heading fixed, animate fast, and follow manual scrolling');

    for (const cancellation of ['touchstart', 'keydown']) {
      const stoppedAt = await page.evaluate(cancellation => {
        const pane = document.querySelector('.settings-content');
        const start = pane.scrollTop;
        [...document.querySelectorAll('.settings-nav button')].find(button => button.textContent === 'Безопасность').click();
        pane.dispatchEvent(cancellation === 'keydown'
          ? new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
          : new Event('touchstart', { bubbles: true }));
        return start;
      }, cancellation);
      await page.waitForTimeout(280);
      assert.ok(Math.abs(await page.locator('.settings-content').evaluate(pane => pane.scrollTop) - stoppedAt) <= 1);
      assert.equal(await settingsNav('Воспроизведение').getAttribute('aria-current'), 'location',
        `${cancellation} cancellation restores the current visible section without a scroll event`);
    }
    check('touch and keyboard cancellation immediately restore the visible navigation item without moving the pane');

    await page.setViewportSize({ width: 390, height: 844 });
    await settingsNav('Внешний вид').click();
    await waitForAnchor('appearance');
    const fixedMobile = await settingsGeometry();
    assert.equal(fixedMobile.overflow, false);
    await page.screenshot({ path: path.join(output, 'settings-phone-appearance.png') });
    await settingsNav('Галерея и поиск').click();
    await waitForAnchor('gallery');
    assert.deepEqual(await settingsGeometry(), fixedMobile);
    await page.screenshot({ path: path.join(output, 'settings-phone-gallery.png') });
    await page.locator('#setting-reduceMotion').selectOption('on');
    const instantAnchor = async (id, label) => page.evaluate(({ id, label }) => {
      const pane = document.querySelector('.settings-content');
      const target = Math.min(pane.scrollHeight - pane.clientHeight,
        pane.scrollTop + document.getElementById('settings-section-' + id).getBoundingClientRect().top - pane.getBoundingClientRect().top);
      [...document.querySelectorAll('.settings-nav button')].find(button => button.textContent === label).click();
      return Math.abs(pane.scrollTop - target);
    }, { id, label });
    assert.ok(await instantAnchor('gallery', 'Галерея и поиск') <= 3);
    await waitForAnchor('gallery');
    await page.locator('#setting-reduceMotion').selectOption('auto');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(await instantAnchor('security', 'Безопасность') <= 3);
    await waitForAnchor('security');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#setting-reduceMotion').selectOption('off');
    await page.setViewportSize({ width: 1440, height: 1000 });
    check('phone settings retain fixed navigation without overflow and reduced motion skips anchor animation');

    await closeSettings();
    await openSettings();
    const beforeAutosave = patches.length;
    await page.evaluate(() => {
      const select = document.getElementById('setting-theme');
      select.value = 'midnight'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#setting-gridColumns').fill('9');
    await settingsNav('Внешний вид').click();
    await waitForAnchor('appearance');
    assert.equal(await page.locator('#setting-theme').inputValue(), 'midnight');
    await waitUntil(() => preferences.get('first.friend').theme === 'midnight' && preferences.get('first.friend').gridColumns === 9,
      'Autosave did not persist theme and grid edits');
    await waitForSaved();
    assert.equal(patches.length, beforeAutosave + 1, 'quick edits share a debounced patch');
    assert.equal(patches.at(-1).accountId, 'first.friend');
    assert.equal(patches.at(-1).patch.theme, 'midnight');
    assert.equal(patches.at(-1).patch.gridColumns, 9);
    await closeSettings();
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight');
    await signOut();
    await signIn('second.friend');
    await openSettings();
    assert.equal(await page.locator('#setting-theme').inputValue(), 'custom_dark');
    await closeSettings();
    await signOut();
    await signIn('first.friend');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight');
    check('settings autosave batches quick edits without Save buttons, survives reload, and switches to each account own preference');

    await openSettings();
    const gate = deferred(); patchGate = gate; heldPatch = gate;
    const beforeConcurrentEdits = patches.length;
    await page.locator('#setting-gridColumns').fill('11');
    await waitUntil(() => patches.length > beforeConcurrentEdits, 'First delayed autosave did not start');
    assert.equal(await page.locator('#setting-gridColumns').isEnabled(), true, 'editing remains available while autosave is pending');
    await page.locator('#setting-gridColumns').fill('12');
    gate.resolve();
    heldPatch = null;
    await waitUntil(() => preferences.get('first.friend').gridColumns === 12, 'Autosave lost the edit made during its pending request');
    await waitForSaved();
    assert.equal(preferences.get('first.friend').gridColumns, 12);
    assert.equal(await page.locator('#setting-gridColumns').inputValue(), '12');
    assert.deepEqual(patches.slice(beforeConcurrentEdits).map(request => request.patch), [{ gridColumns: 11 }, { gridColumns: 12 }]);
    assert.equal(maximumActivePatches, 1, 'settings requests are serialized');
    check('autosave preserves edits made during an outstanding request and persists the newest value in order');

    await settingsSection('gallery').getByRole('button', { name: 'Сбросить раздел', exact: true }).click();
    await waitUntil(() => preferences.get('first.friend').gridColumns === defaultSettings.gridColumns, 'Section reset did not autosave');
    await waitForSaved();
    assert.equal(preferences.get('first.friend').gridColumns, defaultSettings.gridColumns);
    assert.equal(await page.locator('#setting-gridColumns').inputValue(), String(defaultSettings.gridColumns));
    check('resetting a section persists its defaults automatically');

    rejectNextPatch = true;
    const beforeFailedSave = patches.length;
    await page.locator('#setting-gridColumns').fill('13');
    await page.locator('.settings-autosave').getByRole('button', { name: 'Повторить', exact: true }).waitFor();
    assert.equal(patches.length, beforeFailedSave + 1);
    assert.equal(await page.locator('#setting-gridColumns').inputValue(), '13');
    assert.equal(preferences.get('first.friend').gridColumns, defaultSettings.gridColumns);
    await page.locator('.settings-autosave').getByRole('button', { name: 'Повторить', exact: true }).click();
    await waitUntil(() => preferences.get('first.friend').gridColumns === 13, 'Autosave retry did not persist the draft');
    await waitForSaved();
    assert.equal(preferences.get('first.friend').gridColumns, 13);
    check('a failed autosave preserves the draft, exposes retry, and saves successfully on retry');

    const beforeClosing = patches.length;
    await page.locator('#setting-gridColumns').fill('14');
    await closeSettings();
    assert.equal(patches.length, beforeClosing + 1);
    assert.equal(preferences.get('first.friend').gridColumns, 14);
    await openSettings();
    assert.equal(await page.locator('#setting-gridColumns').inputValue(), '14');
    rejectNextPatch = true;
    await page.locator('#setting-gridColumns').fill('15');
    await page.locator('.settings-modal').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.locator('.settings-autosave').getByRole('button', { name: 'Повторить', exact: true }).waitFor();
    assert.equal(await page.locator('.settings-modal').evaluate(dialog => dialog.open && !dialog.inert), true,
      'failed close-flush keeps the settings dialog active');
    assert.equal(await page.locator('#setting-gridColumns').inputValue(), '15');
    assert.equal(preferences.get('first.friend').gridColumns, 14);
    await closeSettings();
    assert.equal(preferences.get('first.friend').gridColumns, 15);
    check('closing settings flushes edits immediately before the debounce expires');
    check('a failed close-flush keeps settings and the draft open, and a repeated close retries the save');

    weakPassword = true;
    await page.reload();
    await page.locator('.weak-password-notice').getByRole('button', { name: 'Сменить пароль', exact: true }).click();
    await page.locator('.modal').evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
    await waitForAnchor('security');
    assert.equal(await settingsNav('Безопасность').getAttribute('aria-current'), 'location');
    await closeSettings();
    weakPassword = false;
    await page.reload();
    await page.locator('.category-photo').waitFor();
    await settlePage();
    check('password warning opens the continuous settings pane at security');

    const exit = await page.evaluate(async () => {
      document.querySelector('.category-photo').click();
      await new Promise(requestAnimationFrame);
      const element = document.querySelector('.page-transition');
      return { state: element.dataset.state, inert: element.inert, animation: getComputedStyle(element).animationName };
    });
    assert.deepEqual(exit, { state: 'leaving', inert: true, animation: 'page-leave' });
    await page.locator('.media-card').waitFor();
    await settlePage();
    await page.getByRole('button', { name: 'Shronchik', exact: true }).click();
    await page.locator('.category-photo').waitFor();
    await settlePage();
    check('home and categories fade out and back in while the outgoing page ignores interactions');

    preferences.set(accountId, { ...settings(), reduceMotion: 'auto' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.locator('.category-photo').waitFor();
    const reducedExit = await page.evaluate(async () => {
      document.querySelector('.category-photo').click();
      await new Promise(requestAnimationFrame);
      const element = document.querySelector('.page-transition');
      return { state: element.dataset.state, inert: element.inert, gallery: Boolean(element.querySelector('.gallery-main')) };
    });
    assert.deepEqual(reducedExit, { state: 'entering', inert: false, gallery: true });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.media-card').waitFor();
    await settlePage();
    check('system reduced-motion preference skips page transition delays');
    assert.equal(await page.locator('.gallery-tools select, .sort-select, .sort-button').count(), 0);
    const image = page.locator('.media-card .card-preview img').first();
    await image.waitFor();
    await page.mouse.move(0, 0);
    const initial = await image.evaluate(element => ({ transform: getComputedStyle(element).transform, width: element.getBoundingClientRect().width }));
    await page.locator('.media-card').first().hover();
    await page.waitForTimeout(350);
    const hovered = await image.evaluate(element => ({ transform: getComputedStyle(element).transform, width: element.getBoundingClientRect().width }));
    assert.equal(hovered.transform, initial.transform);
    assert.ok(Math.abs(hovered.width - initial.width) < 0.1);
    check('gallery has no sorting control and hovering leaves thumbnail scale unchanged');

    await page.locator('.media-card').click();
    await page.locator('#media-rating').waitFor();
    assert.equal(await page.locator('#media-rating').inputValue(), '1000');
    await page.locator('#media-rating').fill('5000');
    await page.locator('#media-rating').press('Enter');
    await page.waitForFunction(() => document.querySelector('.rating-average')?.textContent.replace(/\s/g, '').includes('4000'));
    assert.equal(await page.locator('#media-rating').inputValue(), '5000');
    assert.deepEqual(ratingRequests.at(-1), { accountId: 'first.friend', rating: 5000 });
    await page.locator('.clear-rating').click();
    await page.waitForFunction(() => document.querySelector('.rating-average')?.textContent.replace(/\s/g, '').includes('3000'));
    assert.equal(await page.locator('#media-rating').inputValue(), '');
    await page.screenshot({ path: path.join(output, 'user-rating.png') });
    await page.locator('.back-link').click();
    await page.locator('.player-overlay').waitFor({ state: 'hidden' });
    assert.ok((await page.locator('.card-meta').innerText()).replace(/\s/g, '').includes('3000'));
    check('own rating edits use the returned shared average, and clearing own vote preserves another user vote in player and gallery');

    await page.getByRole('button', { name: 'Shronchik', exact: true }).click();
    await page.locator('.category-photo').waitFor();
    await signOut();
    await signIn('Admin');
    await openSettings();
    assert.equal(await page.locator('.settings-content > .settings-section').count(), 8);
    const shiftedBy = await page.evaluate(async () => {
      const target = document.getElementById('settings-section-storage');
      const before = target.offsetTop;
      [...document.querySelectorAll('.settings-nav button')].find(button => button.textContent === 'Хранилище').click();
      await new Promise(resolve => setTimeout(resolve, 55));
      const growth = document.createElement('div');
      growth.id = 'synthetic-accounts-growth';
      growth.style.height = '640px';
      document.getElementById('settings-section-users').append(growth);
      return target.offsetTop - before;
    });
    assert.equal(shiftedBy, 640);
    await waitForAnchor('storage');
    assert.equal(await settingsNav('Хранилище').getAttribute('aria-current'), 'location');
    await page.locator('#synthetic-accounts-growth').evaluate(element => element.remove());
    check('anchor scrolling follows storage when asynchronously growing account content shifts its position');
    await page.locator('#setting-gridColumns').fill('8');
    await page.locator('#setting-thumbnailCandidates').fill('9');
    const beforeScopedSaves = patches.length;
    await waitUntil(() => preferences.get('Admin').gridColumns === 8 && preferences.get('Admin').thumbnailCandidates === 9,
      'Admin autosave did not persist both settings scopes');
    await waitForSaved();
    assert.equal(patches.length, beforeScopedSaves + 2);
    assert.deepEqual(patches.slice(beforeScopedSaves).find(request => request.endpoint === '/settings/admin'),
      { accountId: 'Admin', endpoint: '/settings/admin', patch: { thumbnailCandidates: 9 } });
    assert.equal(await page.locator('#setting-gridColumns').inputValue(), '8');
    assert.deepEqual(patches.slice(beforeScopedSaves).find(request => request.endpoint === '/settings/ui'),
      { accountId: 'Admin', endpoint: '/settings/ui', patch: { gridColumns: 8 } });
    await closeSettings();
    check('admin autosave preserves common drafts and sends storage and account changes to their own endpoints');
    assert.equal(await page.getByRole('button', { name: 'Загрузить альбом', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Добавить файл', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'admin-home.png') });
    await page.locator('.category-photo').click();
    await page.locator('.media-card').click();
    await page.locator('.player-overlay').waitFor();
    assert.equal(await page.locator('#media-rating, .rating-slider, .clear-rating').count(), 0);
    await page.screenshot({ path: path.join(output, 'admin-rating.png') });
    await page.locator('.back-link').click();
    await page.locator('.player-overlay').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Добавить файл', exact: true }).click();
    await page.locator('.import-modal').waitFor();
    assert.equal(await page.locator('#import-rating, .import-rating-field').count(), 0);
    assert.equal(ratingRequests.filter(request => request.accountId === 'Admin').length, 0);
    check('Admin has upload actions inside categories and no rating controls in viewer or import dialog');
    assert.deepEqual(errors, []);
    console.log(`Interface smoke: ${checks} scenarios passed. Screenshots: ${output}`);
  } finally {
    heldPatch?.resolve();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
