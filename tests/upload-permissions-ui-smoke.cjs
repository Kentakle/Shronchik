// Real browser/server regression using a new, isolated library and synthetic files.
// Build first; SHRONCHIK_PLAYWRIGHT points to an installed Playwright package.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdir, readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { chromium } = require(process.env.SHRONCHIK_PLAYWRIGHT);

const root = path.resolve(__dirname, '..');
const port = Number(process.env.SHRONCHIK_UPLOAD_UI_PORT ?? 5283);
const origin = `http://127.0.0.1:${port}`;
const output = path.join(root, '.cache/upload-permissions-ui-smoke', randomUUID());
const library = path.join(output, 'library');
const serverRoot = path.join(root, 'src/Shronchik.Server');
const localDotnet = path.join(root, '.tools/dotnet/dotnet.exe');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
let server, browser, checks = 0;
const errors = [];
const check = label => { checks++; console.log('PASS ' + label); };
const uploadButton = page => page.locator('.gallery-tools').getByRole('button', { name: 'Добавить файл', exact: true });

async function signIn(page, username, password) {
  await page.goto(origin);
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('.auth-submit').click();
}

async function refreshSession(page) {
  const response = page.waitForResponse(value => value.url() === origin + '/api/v1/session');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session-needed')));
  await response;
}

async function main() {
  await mkdir(output, { recursive: true });
  server = spawn(existsSync(localDotnet) ? localDotnet : 'dotnet', [path.join(serverRoot, 'bin/Debug/net10.0/Shronchik.Server.dll')], {
    cwd: serverRoot, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, SHRONCHIK_PORT: String(port), SHRONCHIK_LIBRARY: library,
      SHRONCHIK_STORAGE_CONFIG: library + '.location.json', SHRONCHIK_PUBLIC_ORIGIN: '' },
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error('Isolated upload-permissions server failed to start.');
    try { if ((await fetch(origin + '/api/v1/health')).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.SHRONCHIK_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const user = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (const page of [admin, user]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
  }
  await signIn(admin, 'Admin', '1111');
  await admin.locator('.category-photo').waitFor();
  await admin.locator('.account-button').click();
  await admin.locator('.account-menu').getByRole('button', { name: 'Настройки', exact: true }).click();
  await admin.locator('.settings-nav').getByRole('button', { name: 'Пользователи', exact: true }).click();
  const panel = admin.locator('.account-settings');
  const create = panel.locator('form.settings-password');
  await create.locator('#account-create-username').fill('upload.friend');
  await create.locator('#account-create-password').fill('synthetic-temporary-password');
  const createPermission = create.getByRole('checkbox', { name: 'Разрешить загрузку', exact: true });
  assert.equal(await createPermission.isChecked(), false);
  await createPermission.check();
  await create.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  const account = panel.locator('.managed-account').filter({ has: admin.getByText('upload.friend', { exact: true }) });
  const permission = account.getByRole('checkbox', { name: 'Разрешить загрузку: upload.friend', exact: true });
  const setPermission = async allowed => {
    const [response] = await Promise.all([
      admin.waitForResponse(value => value.url() === origin + '/api/v1/accounts/upload.friend' && value.request().method() === 'PATCH'),
      permission.click(),
    ]);
    assert.equal((await response.json()).canUpload, allowed);
    await admin.waitForFunction(allowed => document.querySelector('input[aria-label="Разрешить загрузку: upload.friend"]')?.checked === allowed, allowed);
  };
  await permission.waitFor();
  assert.equal(await permission.isChecked(), true);
  await admin.screenshot({ path: path.join(output, 'admin-users-desktop.png') });
  await admin.setViewportSize({ width: 390, height: 844 });
  await permission.scrollIntoViewIfNeeded();
  await admin.screenshot({ path: path.join(output, 'admin-users-mobile.png') });
  assert.ok(await account.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  assert.ok(await permission.evaluate(element => element.getBoundingClientRect().width < 32), 'Checkbox must keep its natural size on phones');
  await admin.setViewportSize({ width: 1440, height: 1000 });
  check('Admin creates an account with an opt-in upload checkbox; permissions fit desktop and mobile');

  await signIn(user, 'upload.friend', 'synthetic-temporary-password');
  await user.locator('#login-new-password').fill('synthetic-private-password');
  await user.locator('#login-confirm-password').fill('synthetic-private-password');
  await user.locator('#login-password').fill('synthetic-temporary-password');
  await user.locator('.auth-submit').click();
  await user.locator('.category-photo').click();
  await uploadButton(user).click();
  const single = user.locator('.import-modal');
  assert.equal(await single.locator('.source-deletion-option').count(), 0);
  assert.equal(await single.getByText('Удалять оригиналы после загрузки', { exact: true }).count(), 0);
  await single.locator('input[type=file]').first().setInputFiles({ name: 'single.png', mimeType: 'image/png', buffer: png });
  await single.getByRole('button', { name: 'Добавить', exact: true }).click();
  await single.waitFor({ state: 'hidden' });
  await user.locator('.media-card').first().waitFor();
  await user.locator('.media-card').first().click();
  await user.locator('.player-overlay[open]').waitFor();
  assert.equal(await user.getByRole('button', { name: /Удалить в корзину|Сменить обложку/ }).count(), 0);
  await user.locator('.player-overlay .back-link').click();
  await user.locator('.player-overlay[open]').waitFor({ state: 'hidden' });
  check('Allowed user uploads a photo and sees no source deletion or shared media deletion actions');

  await user.getByRole('button', { name: 'Загрузить альбом', exact: true }).click();
  const album = user.locator('.album-import-modal');
  assert.equal(await album.getByText('Удалять оригиналы после загрузки', { exact: true }).count(), 0);
  await album.getByLabel('Выбрать фотографии альбома', { exact: true }).setInputFiles([1, 2].map(index => ({
    name: `album-${index}.png`, mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from([index])]),
  })));
  await album.getByRole('button', { name: 'Загрузить фотографии', exact: true }).click();
  await user.waitForFunction(() => document.querySelectorAll('.album-import-photo[data-status="done"]').length === 2);
  await user.screenshot({ path: path.join(output, 'user-album-upload.png') });
  await album.getByRole('button', { name: 'Готово', exact: true }).click();
  await album.waitFor({ state: 'hidden' });
  check('Allowed user uploads multiple photos through the album flow without deleting originals');

  await uploadButton(user).click();
  await setPermission(false);
  await refreshSession(user);
  await single.waitFor({ state: 'hidden' });
  assert.equal(await uploadButton(user).count(), 0);
  assert.equal(await user.getByRole('button', { name: 'Загрузить альбом', exact: true }).count(), 0);
  await user.locator('.media-card').first().waitFor();
  check('Revoking permission closes the open import and hides upload actions while browsing remains available');

  await setPermission(true);
  await refreshSession(user);
  await uploadButton(user).waitFor();
  await user.reload();
  await user.locator('.category-video').click();
  await uploadButton(user).waitFor();
  await user.locator('.brand').click();
  await user.locator('.category-gif').click();
  await uploadButton(user).waitFor();
  const manifest = JSON.parse(await readFile(path.join(library, 'library.json'), 'utf8'));
  assert.equal(manifest.accounts['upload.friend'].canUpload, true);
  assert.deepEqual(errors, []);
  check('Re-enabling works in the active session and persists; video and GIF categories also expose upload');
  console.log(`Upload permissions UI smoke: ${checks} scenarios passed. Isolated library: ${library}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    const done = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await done;
  }
});
