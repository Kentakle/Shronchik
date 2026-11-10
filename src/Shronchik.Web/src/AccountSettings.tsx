import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, mutate } from './api';
import { Icon } from './Icon';
import { errorMessage, strings } from './i18n';
import type { Language, ManagedAccount } from './types';
import './account-settings.css';

const copy = {
  ru: {
    create: 'Создать аккаунт',
    usernameHelp: 'До 32 символов: латинские буквы, цифры, точка, дефис и подчёркивание. Начните с буквы или цифры.',
    passwordHelp: 'При первом входе пользователь задаст свой пароль.',
    active: 'Активен',
    disabled: 'Доступ отключён',
    pending: 'Ожидается смена пароля',
    reset: 'Задать временный пароль',
    disable: 'Отключить доступ',
    enable: 'Включить доступ',
    created: 'Аккаунт создан.',
    resetDone: 'Временный пароль задан.',
    enabledDone: 'Доступ включён.',
    disabledDone: 'Доступ отключён.',
    duplicate: 'Этот логин уже занят.',
    invalidUsername: 'Проверьте формат логина.',
    weakPassword: 'Сначала задайте этому аккаунту временный пароль длиной от 12 символов.',
    remove: 'Удалить аккаунт',
    removing: 'Удаление не завершено',
    removeHint: 'Личная история, рекомендации и альбомы этого аккаунта будут удалены. Файлы общей медиатеки сохранятся.',
    removed: 'Аккаунт удалён.',
    allowUpload: 'Разрешить загрузку',
    uploadHelp: 'Можно добавлять файлы в общую медиатеку. Удаление файлов недоступно.',
    uploadEnabled: 'Загрузка разрешена.',
    uploadDisabled: 'Загрузка запрещена.',
  },
  en: {
    create: 'Create account',
    usernameHelp: 'Up to 32 Latin letters, numbers, periods, hyphens, or underscores. Start with a letter or number.',
    passwordHelp: 'The user will set a new password at their first sign-in.',
    active: 'Active',
    disabled: 'Access disabled',
    pending: 'Password change pending',
    reset: 'Set temporary password',
    disable: 'Disable access',
    enable: 'Enable access',
    created: 'Account created.',
    resetDone: 'Temporary password set.',
    enabledDone: 'Access enabled.',
    disabledDone: 'Access disabled.',
    duplicate: 'This username is already taken.',
    invalidUsername: 'Check the username format.',
    weakPassword: 'Set a temporary password of at least 12 characters for this account first.',
    remove: 'Delete account',
    removing: 'Deletion pending',
    removeHint: 'This account’s history, recommendations, and albums will be deleted. Shared library files will remain.',
    removed: 'Account deleted.',
    allowUpload: 'Allow uploads',
    uploadHelp: 'Can add files to the shared library. File deletion is unavailable.',
    uploadEnabled: 'Uploads allowed.',
    uploadDisabled: 'Uploads disabled.',
  },
} as const;

export function AccountsPanel({ language }: { language: Language }) {
  const t = strings(language);
  const labels = copy[language];
  const [accounts, setAccounts] = useState<ManagedAccount[] | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [canUpload, setCanUpload] = useState(false);
  const [resetUsername, setResetUsername] = useState<string | null>(null);
  const [deleteUsername, setDeleteUsername] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: ManagedAccount[] }>('/accounts', { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setAccounts(response.items); })
      .catch(err => { if (!controller.signal.aborted) setLoadError(errorMessage(err, t)); });
    return () => controller.abort();
  }, [retryCount, t]);

  function describeError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 409) return labels.duplicate;
      if (err.code === 'invalid_username') return labels.invalidUsername;
      if (err.code === 'invalid_password') return t.passwordHelp;
      if (err.code === 'weak_password') return labels.weakPassword;
    }
    return errorMessage(err, t);
  }

  async function saveAccount(path: string, method: 'PATCH' | 'POST', data: unknown, message: string) {
    if (busy || accounts === null) return false;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const account = await mutate<ManagedAccount>(path, method, data);
      setAccounts(previous => {
        if (!previous) return [account];
        if (!previous.some(item => item.username === account.username)) return [...previous, account];
        return previous.map(item => item.username === account.username ? account : item);
      });
      setNotice(message);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally { setBusy(false); }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (await saveAccount('/accounts', 'POST', { username: username.trim(), password, canUpload }, labels.created)) {
      setUsername('');
      setPassword('');
      setCanUpload(false);
    }
  }

  async function reset(event: FormEvent, account: ManagedAccount) {
    event.preventDefault();
    if (await saveAccount(`/accounts/${encodeURIComponent(account.username)}/password`, 'POST',
      { password: resetPassword }, labels.resetDone)) {
      setResetUsername(null);
      setResetPassword('');
    }
  }

  async function removeAccount(account: ManagedAccount) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await mutate(`/accounts/${encodeURIComponent(account.username)}`, 'DELETE');
      setAccounts(previous => previous?.filter(item => item.username !== account.username) ?? null);
      setDeleteUsername(null);
      setResetUsername(null);
      setResetPassword('');
      setNotice(labels.removed);
    } catch (err) {
      setError(describeError(err));
      setRetryCount(value => value + 1);
    } finally { setBusy(false); }
  }

  return <div className="account-settings">
    {loadError ? <>
      <p className="error-text" role="alert">{loadError}</p>
      <button type="button" className="secondary-button" onClick={() => {
        setLoadError('');
        setRetryCount(value => value + 1);
      }}>{t.retry}</button>
    </> : accounts === null ? <p className="help-text" role="status">{t.loading}</p> : <>
      <ul className="account-list">
        {accounts.map(account => <li className="managed-account" key={account.username}>
          <div className="managed-account-summary">
            <span className="managed-account-icon"><Icon name={account.role === 'Admin' ? 'shield' : 'user'} size={18}/></span>
            <div>
              <strong>{account.username}</strong>
              <small>{account.role === 'Admin' ? 'Admin' : account.pendingDeletion ? labels.removing : !account.enabled ? labels.disabled : account.mustChangePassword ? labels.pending : labels.active}</small>
            </div>
          </div>
          {account.role !== 'Admin' && <>
            <label className="account-upload-permission">
              <input type="checkbox" checked={account.canUpload === true} disabled={busy || account.pendingDeletion}
                aria-label={`${labels.allowUpload}: ${account.username}`} onChange={event => {
                  const allowed = event.target.checked;
                  void saveAccount(`/accounts/${encodeURIComponent(account.username)}`, 'PATCH', { canUpload: allowed },
                    allowed ? labels.uploadEnabled : labels.uploadDisabled);
                }}/>
              <span>{labels.allowUpload}</span>
            </label>
            <div className="managed-account-actions">
              <button type="button" className="secondary-button" disabled={busy || account.pendingDeletion} onClick={() => {
                setResetUsername(account.username);
                setDeleteUsername(null);
                setResetPassword('');
                setError('');
                setNotice('');
              }}>{labels.reset}</button>
              <button type="button" className="secondary-button" disabled={busy || account.pendingDeletion} onClick={() => {
                const enabled = !account.enabled;
                void saveAccount(`/accounts/${encodeURIComponent(account.username)}`, 'PATCH', { enabled },
                  enabled ? labels.enabledDone : labels.disabledDone);
              }}>{account.enabled ? labels.disable : labels.enable}</button>
              <button type="button" className="text-button danger-text" disabled={busy} onClick={() => {
                setDeleteUsername(account.username);
                setResetUsername(null);
                setResetPassword('');
              }}>{labels.remove}</button>
            </div>
            {deleteUsername === account.username && <div className="inline-confirm">
              <strong>{account.username}</strong><p>{labels.removeHint}</p>
              <button type="button" className="danger-button" disabled={busy} onClick={() => { void removeAccount(account); }}>{t.confirm}</button>
              <button type="button" className="text-button" disabled={busy} onClick={() => setDeleteUsername(null)}>{t.cancel}</button>
            </div>}
            {resetUsername === account.username && <form className="managed-account-reset" onSubmit={event => { void reset(event, account); }}>
              <label className="field-label" htmlFor="account-reset-password">{t.temporaryPassword}</label>
              <input id="account-reset-password" type="password" autoComplete="new-password" minLength={12} maxLength={256}
                value={resetPassword} onChange={event => setResetPassword(event.target.value)} required disabled={busy}/>
              <p className="help-text">{t.passwordHelp} {labels.passwordHelp}</p>
              <div className="managed-account-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => {
                  setResetUsername(null);
                  setResetPassword('');
                }}>{t.cancel}</button>
                <button className="primary-button" disabled={busy}>{t.save}</button>
              </div>
            </form>}
          </>}
        </li>)}
      </ul>
      <form className="settings-password" onSubmit={event => { void create(event); }}>
        <h3>{labels.create}</h3>
        <label className="field-label" htmlFor="account-create-username">{t.username}</label>
        <input id="account-create-username" value={username} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,31}"
          autoCapitalize="none" spellCheck={false} autoComplete="off" aria-describedby="account-username-help"
          onChange={event => setUsername(event.target.value)} required disabled={busy}/>
        <p className="help-text" id="account-username-help">{labels.usernameHelp}</p>
        <label className="field-label" htmlFor="account-create-password">{t.temporaryPassword}</label>
        <input id="account-create-password" type="password" autoComplete="new-password" minLength={12} maxLength={256}
          value={password} onChange={event => setPassword(event.target.value)} required disabled={busy}/>
        <p className="help-text">{t.passwordHelp} {labels.passwordHelp}</p>
        <label className="account-upload-permission">
          <input type="checkbox" checked={canUpload} onChange={event => setCanUpload(event.target.checked)} disabled={busy}
            aria-describedby="account-create-upload-help"/>
          <span>{labels.allowUpload}</span>
        </label>
        <p className="help-text" id="account-create-upload-help">{labels.uploadHelp}</p>
        <div className="modal-actions"><button className="primary-button" disabled={busy}><Icon name="plus" size={16}/>{labels.create}</button></div>
      </form>
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <p className="success-text" role="status"><Icon name="check" size={16}/>{notice}</p>}
  </div>;
}

export function PasswordForm({ language, onPasswordChanged }: { language: Language; onPasswordChanged: () => void }) {
  const t = strings(language);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function change(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSuccess(false);
    if (newPassword !== confirmation) {
      setError(t.passwordsMismatch);
      return;
    }
    if (currentPassword === newPassword) {
      setError(t.passwordMustDiffer);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await mutate('/auth/password/self', 'POST', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setSuccess(true);
      onPasswordChanged();
    } catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }

  return <form className="settings-password" onSubmit={event => { void change(event); }}>
    <h3>{t.changePassword}</h3>
    <label className="field-label" htmlFor="current-password">{t.currentPassword}</label>
    <input id="current-password" type="password" autoComplete="current-password" required value={currentPassword}
      onChange={event => setCurrentPassword(event.target.value)} disabled={busy}/>
    <label className="field-label" htmlFor="new-password">{t.newPassword}</label>
    <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required
      value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={busy}/>
    <label className="field-label" htmlFor="confirm-password">{t.confirmPassword}</label>
    <input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required
      value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy}/>
    <p className="help-text">{t.passwordHelp}</p>
    {error && <p className="error-text" role="alert">{error}</p>}
    {success && <p className="success-text" role="status">{t.passwordChanged}</p>}
    <div className="modal-actions"><button className="primary-button" disabled={busy}>{busy && <span className="spinner"/>}{t.changePassword}</button></div>
  </form>;
}
