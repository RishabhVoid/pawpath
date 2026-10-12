import { useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { api } from './lib/api.js';
import type { Pet } from '../../shared/types.js';
import { PetArt } from './PetArt.js';

export function AccountScreen({ existingPet, onConnected, onCancel }: { existingPet?: Pet; onConnected: (token: string) => Promise<void>; onCancel?: () => void }) {
  const [login, setLogin] = useState(false), [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="account-screen">
    <div className="account-intro"><span className="small-label">YOUR POCKET COMPANION</span><h1>{login ? 'Welcome back.' : existingPet ? `Keep ${existingPet.name} with you.` : 'Your trail starts here.'}</h1><p>{login ? 'Your buddy’s right where you left them.' : 'A name for your account. A little friend for the road.'}</p><div className="account-habitat"><div className="home-habitat" aria-hidden="true"><span className="habitat-orbit"/><span className="habitat-ledge"/><span className="habitat-plant"/></div><PetArt species={existingPet?.species || "pip"} equipped={existingPet?.equippedItems}/><span className="account-pet-caption">{existingPet?.name || "Someone little is waiting."}</span></div></div>
    <form className="account-form" onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void api<{ token: string }>('/account/' + (login ? 'login' : 'register'), { method: 'POST', body: JSON.stringify({ username, password }) }).then(result => onConnected(result.token)).catch(error => setError(error.message)).finally(() => setBusy(false)); }}>
      <h2>{login ? 'Sign in' : 'Make it yours'}</h2>
      {existingPet && !login && <p className="quiet-note">Your pet, walks, memories, and outfits stay with you.</p>}
      <label htmlFor="account-username">Username</label><input id="account-username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value.toLowerCase())} minLength={3} maxLength={24} pattern="[a-z][a-z0-9_]{2,23}" required/><p className="quiet-note">Letters, numbers, underscores. 3–24 characters.</p>
      <label htmlFor="account-password">Password</label><input id="account-password" type="password" autoComplete={login ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} minLength={6} maxLength={128} required/><p className="quiet-note">6 characters or more.</p>
      {error && <p className="account-error" role="alert">{error}</p>}
      <button className="primary-button full" disabled={busy}>{busy ? <><LoaderCircle size={18} className="spin"/>Opening your trail…</> : <>{login ? 'Sign in' : 'Create my account'}<ArrowRight size={19}/></>}</button>
      <button type="button" className="text-button centered" disabled={busy} onClick={() => { setLogin(!login); setPassword(''); setError(''); }}>{login ? 'New here? Create an account' : 'Already have a buddy? Sign in'}</button>
      <p className="quiet-note">No email. Just your username and password.</p>
      {onCancel && <button type="button" className="text-button centered" disabled={busy} onClick={onCancel}>Back to my buddy</button>}
    </form>
  </section>;
}
