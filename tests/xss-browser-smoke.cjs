const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdirSync, existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

if (!process.env.SHRONCHIK_PLAYWRIGHT) throw new Error('Set SHRONCHIK_PLAYWRIGHT to an installed Playwright package path.');
const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);
const root = path.resolve(__dirname, '..');
const port = Number(process.env.SHRONCHIK_XSS_PORT ?? 5282);
const origin = `http://127.0.0.1:${port}`;
const library = path.join(root, '.cache/xss-browser-smoke', randomUUID(), 'library');
mkdirSync(path.dirname(library), { recursive: true });
const localDotnet = path.join(root, '.tools/dotnet/dotnet.exe');
const serverRoot = path.join(root, 'src/Shronchik.Server');
const server = spawn(existsSync(localDotnet) ? localDotnet : 'dotnet', [path.join(serverRoot, 'bin/Debug/net10.0/Shronchik.Server.dll')], {
  cwd: serverRoot, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, SHRONCHIK_PORT: String(port), SHRONCHIK_LIBRARY: library,
    SHRONCHIK_STORAGE_CONFIG: library + '.location.json', SHRONCHIK_PUBLIC_ORIGIN: '' },
});
let browser;
let passed = 0;
const check = message => { passed++; console.log('PASS ' + message); };

async function main() {
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error('Isolated XSS server failed to start.');
      try { if ((await fetch(origin + '/api/v1/health')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const edge = process.env.SHRONCHIK_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    browser = await chromium.launch({ executablePath: edge, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.addInitScript(() => { window.__shronchikXssProbe = 0; });
    await page.goto(origin);
    await page.locator('#login-username').fill('Admin');
    await page.locator('#login-password').fill('1111');
    await page.locator('.auth-submit').click();
    await page.locator('.category-photo').waitFor();

    const payload = {
      title: '<img data-xss=title src=x onerror=window.__shronchikXssProbe=1><script data-xss=script>window.__shronchikXssProbe=2</script>',
      tag: '<svg data-xss=tag onload=window.__shronchikXssProbe=3>',
      album: '<img data-xss=album src=x onerror=window.__shronchikXssProbe=4>',
    };
    await page.evaluate(async input => {
      const session = await (await fetch('/api/v1/session')).json();
      const jsonHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QAAAABJRU5ErkJggg=='), ch => ch.charCodeAt(0));
      const rejected = await fetch('/api/v1/imports?' + new URLSearchParams({ fileName: 'neutral.png', title: input.title, tags: input.tag }), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': session.csrfToken }, body: png,
      });
      if (rejected.status !== 400) throw new Error('Unlisted XSS tag was not rejected: ' + rejected.status);
      const imported = await fetch('/api/v1/imports?' + new URLSearchParams({ fileName: 'neutral.png', title: input.title, tags: 'Asia' }), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': session.csrfToken }, body: png,
      });
      if (imported.status !== 201) throw new Error('Synthetic XSS import failed: ' + imported.status);
      const photo = await imported.json();
      const temporaryPassword = 'synthetic-xss-temporary-password';
      const account = await fetch('/api/v1/accounts', { method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({ username: 'synthetic.xss', password: temporaryPassword }) });
      if (account.status !== 201) throw new Error('Synthetic XSS account failed: ' + account.status);
      const login = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'synthetic.xss', password: temporaryPassword }) });
      if (login.status !== 200) throw new Error('Synthetic XSS user login failed: ' + login.status);
      const user = await login.json();
      const userHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': user.csrfToken };
      const password = await fetch('/api/v1/auth/password/self', { method: 'POST', headers: userHeaders,
        body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: 'synthetic-xss-private-password' }) });
      if (password.status !== 200) throw new Error('Synthetic XSS user setup failed: ' + password.status);
      const created = await fetch('/api/v1/albums', { method: 'POST', headers: userHeaders, body: JSON.stringify({ name: input.album }) });
      if (created.status !== 201) throw new Error('Synthetic XSS album failed: ' + created.status);
      const album = await created.json();
      const linked = await fetch(`/api/v1/albums/${album.id}/items/${photo.id}`, { method: 'PUT', headers: userHeaders });
      if (linked.status !== 204) throw new Error('Synthetic XSS membership failed: ' + linked.status);
    }, payload);
    check('HTML payload in an unlisted tag is rejected before import');

    async function assertInert() {
      assert.equal(await page.locator('[data-xss]').count(), 0, 'Stored HTML must not create attacker DOM nodes');
      assert.equal(await page.evaluate(() => window.__shronchikXssProbe), 0, 'Stored payload executed');
      assert.deepEqual(dialogs, []);
    }
    await page.reload();
    await page.locator('.category-photo').click();
    const card = page.locator('.media-card').first();
    await card.waitFor();
    assert.equal(await card.locator('h3').textContent(), payload.title);
    assert.equal(await card.locator('h3').getAttribute('title'), payload.title);
    assert.equal(await card.locator('h3').locator('*').count(), 0);
    assert.equal(await card.locator('.thumbnail-tag').textContent(), '#Asia');
    await assertInert();
    check('stored HTML/script in the title renders literally beside an English tag after reload');

    await card.click();
    const player = page.locator('.player-overlay[open]');
    await player.waitFor();
    assert.equal(await player.locator('.player-main-info h1').textContent(), payload.title);
    assert.equal(await player.locator('.media-tags button').textContent(), '#Asia');
    assert.equal(await player.locator('.player-main-info h1').locator('*').count(), 0);
    await assertInert();
    check('stored title payload remains text in the player without executing handlers');
    await player.locator('.back-link').click();
    await player.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: 'Альбомы', exact: true }).click();
    const album = page.locator('.album-card').first();
    await album.waitFor();
    assert.equal(await album.locator('strong').textContent(), payload.album);
    assert.equal(await album.locator('strong').locator('*').count(), 0);
    await assertInert();
    await album.locator('.album-open').click();
    assert.equal(await page.locator('.albums-section h2').textContent(), payload.album);
    assert.equal(await page.locator('.albums-section .media-card h3').textContent(), payload.title);
    await assertInert();
    check('stored album name remains literal in album list, heading and member gallery');
    assert.deepEqual(errors, []);
    console.log(`Browser XSS smoke: ${passed} scenarios passed in Edge. Only synthetic PNG and isolated library used.`);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      const done = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await done;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
