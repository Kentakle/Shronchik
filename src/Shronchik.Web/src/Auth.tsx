import { useState } from 'react';
import type { FormEvent } from 'react';
import { mutate } from './api';
import { errorMessage, strings } from './i18n';
import { Icon } from './Icon';
import type { Language, Session } from './types';

export function Auth({ session, language, onLanguage, onSession, serverError }: {
  session: Session; language: Language; onLanguage: (value: Language) => void; onSession: (value: Session) => void; serverError?: string;
}) {
  const t = strings(language);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mustChange = session.authenticated && !session.locked && session.mustChangePassword;
  const action = mustChange ? t.changePassword : session.locked ? t.unlock : t.signIn;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (mustChange && newPassword !== confirmation) {
      setError(t.passwordsMismatch);
      return;
    }
    if (mustChange && password === newPassword) {
      setError(t.passwordMustDiffer);
      return;
    }
    setBusy(true);
    try {
      const path = mustChange ? '/auth/password/self' : session.locked ? '/auth/unlock' : '/auth/login';
      const credentials = mustChange ? { currentPassword: password, newPassword }
        : session.locked ? { password } : { username: username.trim(), password };
      const result = await mutate<Session>(path, 'POST', credentials);
      setPassword('');
      setNewPassword('');
      setConfirmation('');
      onSession(result);
    } catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await mutate<Session>('/auth/logout', 'POST');
      setPassword('');
      setNewPassword('');
      setConfirmation('');
      onSession(result);
    } catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  return <div className="auth-page">
    <div className="auth-decoration" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><span className="orbit-center"><Icon name="shield" size={56}/></span><span className="orbit-dot dot-one"/><span className="orbit-dot dot-two"/></div>
    <header className="auth-header"><Brand/><button className="text-button language-button" onClick={() => onLanguage(language === 'ru' ? 'en' : 'ru')}>{language === 'ru' ? 'EN' : 'RU'}</button></header>
    <main className="auth-layout"><div className="auth-intro"><span className="eyebrow"><span className="status-dot"/>{t.privateLibrary}</span><h1>{session.locked ? t.locked : t.authTitle}</h1><p>{session.locked ? t.lockedText : t.authText}</p><div className="auth-features"><span><Icon name="shield" size={17}/>{t.encrypted}</span><span><Icon name="lock" size={17}/>{t.accountAccess}</span></div></div>
    <form className="auth-card" onSubmit={e => { void submit(e); }}><span className="auth-card-icon"><Icon name={session.locked || mustChange ? 'lock' : 'unlock'} size={25}/></span><h2>{action}</h2>
      {session.locked || mustChange ? <div className="locked-account"><Icon name="user"/>{session.accountId ?? session.role}</div> : <>
        <label className="field-label" htmlFor="login-username">{t.username}</label>
        <input id="login-username" autoComplete="username" autoCapitalize="none" spellCheck={false}
          value={username} maxLength={32} onChange={e => setUsername(e.target.value)} required autoFocus disabled={busy}/>
      </>}
      {mustChange && <p className="help-text">{t.temporaryPasswordPrompt}</p>}
      <label className="field-label" htmlFor="login-password">{mustChange ? t.temporaryPassword : t.password}</label>
      <input id="login-password" type="password" autoComplete="current-password" value={password}
        onChange={e => setPassword(e.target.value)} required autoFocus={session.locked || mustChange} placeholder="••••••••" disabled={busy}/>
      {mustChange && <>
        <label className="field-label" htmlFor="login-new-password">{t.newPassword}</label>
        <input id="login-new-password" type="password" autoComplete="new-password" minLength={12} maxLength={256}
          value={newPassword} onChange={e => setNewPassword(e.target.value)} required disabled={busy}/>
        <label className="field-label" htmlFor="login-confirm-password">{t.confirmPassword}</label>
        <input id="login-confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={256}
          value={confirmation} onChange={e => setConfirmation(e.target.value)} required disabled={busy}/>
      </>}
      {(error || serverError) && <p className="error-text" role="alert">{error || serverError}</p>}<button className="primary-button auth-submit" disabled={busy}>{busy ? <span className="spinner"/> : <>{action}<Icon name="arrow" size={18}/></>}</button>
      {mustChange && <button type="button" className="text-button initial-password" disabled={busy} onClick={() => { void signOut(); }}>{t.logout}</button>}
      {!session.locked && !mustChange && <p className="initial-password">{t.accountsByAdmin}</p>}
    </form></main><footer className="auth-footer"><span>Shronchik by kentakle</span><span>{t.privateLibrary}</span></footer>
  </div>;
}

export function Brand({ onClick }: { onClick?: () => void }) {
  const content = <><span className="brand-mark"><span/><span/><span/></span><span>shronchik<span className="brand-period">.</span></span></>;
  return onClick ? <button className="brand" onClick={onClick} aria-label="Shronchik">{content}</button> : <div className="brand">{content}</div>;
}
