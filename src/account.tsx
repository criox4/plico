// Account: splash, welcome + sign-in flows, password reset, verification, the account hub and its pages, claim links.
import { useEffect, useState, type ReactNode } from 'react'
import { Capacitor } from '@capacitor/core'
import { inr, isVpa, type Kind, type Tone } from './logic'
import { update, type State } from './store'
import { authClient } from './auth-client'
import { api, isPhone, pull, refreshUser, signOut, signedIn, uploadImage, useSync } from './sync'
import { THEMES, ensureFonts, theme, themeVars, type ThemeId } from './themes'
import { Icon, type IconName } from './icons'
import { Avatar, EMOJI, Ornament, Plico, Screen, ThemePicker, TONES, Wordmark, calm, go, randomSeed, useTicker } from './ui'

const origin = () => location.origin + location.pathname.replace(/index\.html$/, '')
const msg = (e: unknown, fallback = 'That didn’t work. Your balances are safe. Try again.') =>
  (e as { message?: string })?.message || fallback
const cleanUrl = (hash = '#/') => history.replaceState(null, '', location.pathname + hash)

// ---------- splash ----------
export function Splash() {
  return (
    <div className="splash" role="status" aria-label="Plico is starting">
      <Plico mood="settled" size={112} />
      <span className="splash-word">plico</span>
    </div>
  )
}

// ---------- Google (web redirect, native ID token) ----------
async function googleSignIn(webClientId: string | null, iosClientId: string | null) {
  if (!Capacitor.isNativePlatform()) {
    // Leaves the page; the boot session check signs us in when Google sends us back.
    const r = await authClient.signIn.social({ provider: 'google', callbackURL: `${origin()}#/` })
    if (r.error) throw new Error(r.error.message)
    return
  }
  // Google blocks its sign-in page inside WebViews, so native apps use the platform SDK and hand the ID token over.
  const { SocialLogin } = await import('@capgo/capacitor-social-login')
  await SocialLogin.initialize({ google: { webClientId: webClientId ?? undefined, iOSClientId: iosClientId ?? undefined, iOSServerClientId: webClientId ?? undefined, mode: 'online' } })
  const login = await SocialLogin.login({ provider: 'google', options: { scopes: ['email', 'profile'] } })
  const idToken = (login.result as { idToken?: string | null }).idToken
  if (!idToken) throw new Error('Google didn’t return a sign-in token.')
  const r = await authClient.signIn.social({ provider: 'google', idToken: { token: idToken } })
  if (r.error) throw new Error(r.error.message)
  const u = (r.data as { user?: Parameters<typeof signedIn>[0] }).user ?? (await authClient.getSession()).data?.user
  if (u) await signedIn(u)
}

// ---------- welcome showcase: sample groups, each in its own theme, settling in turn ----------
const SAMPLES: { name: string; kind: Kind; t: ThemeId; amount: number; line: string }[] = [
  { name: 'Goa 2027', kind: 'trip', t: 'goa', amount: 932000, line: 'Rohan and Isha owe you' },
  { name: 'Flat 404', kind: 'home', t: 'auto', amount: -485000, line: 'Your share of rent and bills' },
  { name: 'Friday football', kind: 'friends', t: 'midnight', amount: 68000, line: 'Karan owes you for the turf' },
]
const SHOW_MS = 1600, SETTLE_MS = 2000, OUT_MS = 420

function ShowCard({ sample, pos, settled }: { sample: typeof SAMPLES[number]; pos: number; settled: boolean }) {
  const value = useTicker(settled ? 0 : Math.abs(sample.amount), 900)
  const th = theme(sample.t)
  return (
    <div className={`show-card pos-${pos}${settled ? ' settled' : ''}`} data-theme={sample.t} style={themeVars(sample.t)}>
      <Ornament t={sample.t} />
      <div className="show-head">
        <span className="slip-kind"><Icon n={sample.kind} /></span>
        <strong>{sample.name}</strong>
        <span className="show-theme">{th.name}</span>
      </div>
      <p className={`show-num hero-num ${settled ? '' : sample.amount > 0 ? 'pos' : 'neg'}`}><span className="cur">₹</span>{inr(value).replace('₹', '')}</p>
      <p className="show-line">{settled ? 'Paid over UPI. Everyone’s even ✨' : sample.line}</p>
      <span className="show-stamp">{th.celebrate}</span>
    </div>
  )
}

function Showcase() {
  const [front, setFront] = useState(0)
  const [phase, setPhase] = useState<'show' | 'settle' | 'out'>('show')
  const [retry, setRetry] = useState(0)
  useEffect(() => ensureFonts(SAMPLES.map(x => x.t)), [])
  useEffect(() => {
    if (calm()) return // reduced motion: a still stack, no loop
    const wait = { show: SHOW_MS, settle: SETTLE_MS, out: OUT_MS }[phase]
    const id = setTimeout(() => {
      if (document.hidden) return setRetry(r => r + 1) // paused while the tab is hidden
      if (phase === 'show') setPhase('settle')
      else if (phase === 'settle') setPhase('out')
      else { setFront(f => (f + 1) % SAMPLES.length); setPhase('show') }
    }, wait)
    return () => clearTimeout(id)
  }, [phase, front, retry])
  return (
    <figure className="showcase" aria-label="Three sample groups, each in its own theme">
      <div className="show-stack" aria-hidden>
        {SAMPLES.map((x, i) => {
          const pos = (i - front + SAMPLES.length) % SAMPLES.length
          return <ShowCard key={x.name} sample={x} pos={pos === 0 && phase === 'out' ? -1 : pos} settled={pos === 0 && phase !== 'show'} />
        })}
      </div>
      <figcaption>Sample groups. Every group wears its own theme.</figcaption>
    </figure>
  )
}

// ---------- welcome + auth ----------
type Step = 'welcome' | 'signup' | 'signin' | 'forgot' | 'sent'

export function AuthFlow({ s, notice }: { s: State; notice?: string }) {
  const sync = useSync()
  const returning = !!s.user
  const [step, setStep] = useState<Step>(returning ? 'signin' : 'welcome')
  const [name, setName] = useState(s.me.name)
  const [email, setEmail] = useState(s.user?.email ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(sync.error)
  const invited = /^#\/(claim|join)\//.test(location.hash)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr('')
    try { await fn() } catch (e) { setErr(msg(e, 'Can’t reach Plico. Check your connection and try again. Your balances are safe.')) } finally { setBusy(false) }
  }
  const submit = () => run(async () => {
    if (step === 'forgot') {
      const r = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: `${origin()}#/reset` })
      if (r.error) throw new Error(r.error.message)
      return setStep('sent')
    }
    const r = step === 'signup'
      ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password, callbackURL: `${origin()}#/verified` })
      : await authClient.signIn.email({ email: email.trim(), password })
    if (r.error) throw new Error(r.error.status === 401 ? 'That email and password don’t match.' : r.error.message)
    await signedIn(r.data.user)
  })
  const google = () => run(() => googleSignIn(sync.googleWebClientId, sync.googleIosClientId))
  // App Store 4.8: offering Google sign-in on iOS requires Sign in with Apple too. Until that's added, iOS is email-only.
  const showGoogle = sync.google && Capacitor.getPlatform() !== 'ios'
  const to = (next: Step) => { setStep(next); setErr('') }

  useEffect(() => ensureFonts(['classic']), [])
  if (step === 'welcome')
    return (
      <div className="welcome" data-theme="classic" style={themeVars('classic')}>
        <div className="welcome-top">
          <Wordmark />
          <h1>Money together, sorted.</h1>
          <div className="hello"><Plico mood="idle" size={52} /><p><strong>Hi. I’m Plico.</strong>I keep track of the awkward money stuff, so trips, rent and dinners stay fun.</p></div>
          {(notice || invited) && <p className="notice" role="status">{notice || 'You’ve been invited to a group. Create an account or sign in to join it.'}</p>}
          <Showcase />
          <ul className="points">
            <li><Icon n="send" />Friends pay from a link. No app needed.</li>
            <li><Icon n="check" />Works offline. Syncs when you’re back.</li>
            <li><Icon n="qr" />Pay by UPI or QR, to a name you can see.</li>
          </ul>
        </div>
        <div className="welcome-actions">
          {showGoogle && <button className="btn google" disabled={busy} onClick={() => void google()}><GoogleG />Continue with Google</button>}
          <button className="btn primary" onClick={() => to('signup')}>Create an account</button>
          <button className="btn secondary" onClick={() => to('signin')}>I already have an account</button>
          {err && <p className="error" role="alert">{err}</p>}
        </div>
      </div>
    )

  const title = { signup: 'Create your account', signin: returning ? 'Welcome back' : 'Sign in', forgot: 'Reset your password', sent: 'Check your email' }[step]
  return (
    <Screen t="classic" back={() => to(returning && step === 'signin' ? 'signin' : 'welcome')} title={title}>
      <div className="auth">
        {notice && <p className="notice" role="status">{notice}</p>}
        {step === 'sent' ? <>
          <p className="muted-p">If <strong>{email}</strong> has a Plico account, a link to choose a new password is on its way. It works for one hour.</p>
          <button className="btn secondary" onClick={() => to('signin')}>Back to sign in</button>
        </> : <>
          {showGoogle && step !== 'forgot' && <>
            <button className="btn google" disabled={busy} onClick={() => void google()}><GoogleG />Continue with Google</button>
            <p className="or"><span>or with email</span></p>
          </>}
          {step === 'forgot' && <p className="muted-p">Enter the email you signed up with and we’ll send a reset link.</p>}
          <form className="form" onSubmit={e => { e.preventDefault(); void submit() }}>
            {step === 'signup' && (
              <label className="field"><span>Your name</span><input value={name} onChange={e => setName(e.target.value)} autoComplete="name" required maxLength={40} /></label>
            )}
            <label className="field"><span>Email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" required />
              {step === 'signup' && <small>Use the email friends know you by. Groups they add it to appear once you verify it.</small>}
            </label>
            {step !== 'forgot' && (
              <label className="field"><span>Password</span>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} required
                  autoComplete={step === 'signup' ? 'new-password' : 'current-password'} />
                {step === 'signup' && <small>At least 8 characters.</small>}
              </label>
            )}
            {err && <p className="error" role="alert">{err}</p>}
            <button className="btn primary" disabled={busy}>
              {busy ? 'One moment…' : { signup: 'Create account', signin: 'Sign in', forgot: 'Send reset link' }[step]}
            </button>
          </form>
          {step === 'signin' && <button className="link center-link" onClick={() => to('forgot')}>Forgot password?</button>}
          <button className="link center-link" onClick={() => to(step === 'signup' ? 'signin' : 'signup')}>
            {step === 'signup' ? 'I already have an account' : 'I’m new here: create an account'}
          </button>
        </>}
      </div>
    </Screen>
  )
}

const GoogleG = () => (
  <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.7 17.8 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.4-4.6 7l7.4 5.8c4.3-4 6.9-9.9 6.9-17.3z" />
    <path fill="#FBBC05" d="M10.6 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l8-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-8 6.1C6.6 42.6 14.6 48 24 48z" />
  </svg>
)

// ---------- reset password (from the emailed link: ?token=… before the hash) ----------
export function ResetPassword() {
  const q = new URLSearchParams(location.search)
  const token = q.get('token')
  const [pw, setPw] = useState('')
  const [state, setState] = useState<'form' | 'done'>('form')
  const [err, setErr] = useState(q.get('error') ? 'This reset link has expired or was already used. Ask for a new one.' : '')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    const r = await authClient.resetPassword({ newPassword: pw, token: token ?? '' }).catch(e => ({ error: { message: msg(e) } }))
    setBusy(false)
    if (r.error) return setErr(r.error.message || 'This reset link has expired. Ask for a new one.')
    setState('done')
  }
  const finish = () => { cleanUrl('#/'); location.reload() }
  return (
    <Screen t="classic" title="Choose a new password">
      <div className="auth">
        {state === 'done' ? <>
          <p className="notice" role="status">Password changed. For safety, you’ve been signed out on every device.</p>
          <button className="btn primary" onClick={finish}>Sign in</button>
        </> : <form className="form" onSubmit={e => { e.preventDefault(); void submit() }}>
          <label className="field"><span>New password</span>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} minLength={8} required autoComplete="new-password" autoFocus />
            <small>At least 8 characters.</small>
          </label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn primary" disabled={busy || !token}>{busy ? 'Saving…' : 'Save new password'}</button>
          {!token && <button type="button" className="link center-link" onClick={finish}>Back to sign in</button>}
        </form>}
      </div>
    </Screen>
  )
}

// ---------- verification ----------
export function VerifyBanner({ s }: { s: State }) {
  const [sent, setSent] = useState('')
  if (!s.user || s.user.emailVerified) return null
  const resend = async () => {
    const r = await authClient.sendVerificationEmail({ email: s.user!.email, callbackURL: `${origin()}#/verified` }).catch(() => null)
    setSent(r && !r.error ? 'Sent. Check your inbox.' : 'Couldn’t send right now. Try again in a bit.')
  }
  const check = async () => { if ((await refreshUser())?.emailVerified) await pull() }
  return (
    <section className="banner" role="status">
      <Icon n="mail" size={20} />
      <div>
        <strong>Verify {s.user.email}</strong>
        <p>Groups friends added this email to appear once it’s verified.</p>
        <div className="banner-actions">
          <button className="btn-sm" onClick={() => void resend()}>{sent ? 'Resend' : 'Send link'}</button>
          <button className="btn-sm ghost" onClick={() => void check()}>I’ve verified</button>
        </div>
        {sent && <small>{sent}</small>}
      </div>
    </section>
  )
}

/** Landing page after clicking a verification link. */
export function Verified() {
  useEffect(() => { void refreshUser().then(() => pull()).then(() => location.replace('#/')) }, [])
  return <Splash />
}

// ---------- claim a personal invite ----------
export function Claim({ s, token }: { s: State; token: string }) {
  type C = { group: { id: string; name: string; kind: Kind; theme: ThemeId }; name: string }
  const [c, setC] = useState<C | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<C>(`/api/claim/${token}`).then(setC, e => setErr(msg(e))) }, [token])
  const join = async () => {
    setBusy(true)
    try {
      const r = await api<{ id: string }>(`/api/claim/${token}`, { method: 'POST' })
      await pull()
      location.replace('#/g/' + r.id)
    } catch (e) { setErr(msg(e)); setBusy(false) }
  }
  return (
    <Screen t={c?.group.theme ?? s.theme} title="Join group">
      {!c ? <p className="empty">{err || 'Opening invite…'}</p> : (
        <div className="auth">
          <Icon n={c.group.kind} size={40} />
          <h1 className="q">{c.group.name}</h1>
          <p className="muted-p">You were added as <strong>{c.name}</strong>. Join to see what you owe or are owed.</p>
          <button className="btn primary" disabled={busy} onClick={() => void join()}>Join as {c.name}</button>
          {err && <p className="error" role="alert">{err}</p>}
        </div>
      )}
    </Screen>
  )
}

// ---------- account hub ----------
function Row({ icon, title, sub, to, danger }: { icon: IconName; title: string; sub?: string; to: string; danger?: boolean }) {
  return (
    <li className="ledger-row">
      <button onClick={() => go(to)}>
        <span className="cat"><Icon n={icon} /></span>
        <span className="lr-body"><strong className={danger ? 'neg' : ''}>{title}</strong>{sub && <small>{sub}</small>}</span>
        <Icon n="arrow" size={18} />
      </button>
    </li>
  )
}

export function AccountHub({ s }: { s: State }) {
  const sync = useSync()
  const out = () => {
    if (sync.pending && !confirm(`${sync.pending} change${sync.pending > 1 ? 's haven’t' : ' hasn’t'} synced yet and will be lost. Sign out anyway?`)) return
    void signOut()
  }
  return (
    <Screen t={s.theme} back title="Account">
      <section className="profile-card">
        <Avatar name={s.me.name} image={s.user?.image} />
        <div>
          <strong>{s.me.name || 'You'}</strong>
          <small>{s.user?.email}</small>
          <span className={`chip-state ${s.user?.emailVerified ? 'ok' : 'warn'}`}>{s.user?.emailVerified ? 'Verified' : 'Not verified'}</span>
        </div>
      </section>
      <ol className="ledger">
        <Row icon="user" title="Profile" sub={[s.me.phone, s.me.upi].filter(Boolean).join(' · ') || 'Name, phone, UPI ID'} to="/me/profile" />
        <Row icon="settings" title="Appearance" sub={`${theme(s.theme).name} theme`} to="/me/theme" />
        <Row icon="bell" title="Reminders" sub={`${s.tone[0].toUpperCase()}${s.tone.slice(1)} tone`} to="/me/tone" />
        <Row icon="lock" title="Email and password" sub="Change email, change password" to="/me/security" />
        <Row icon="phone" title="Devices" sub="Where you’re signed in" to="/me/devices" />
      </ol>
      <SyncLine />
      <button className="btn secondary" onClick={out}>Sign out</button>
      <ol className="ledger danger-zone"><Row icon="trash" title="Delete account" to="/me/delete" danger /></ol>
      <a className="link center-link" href="#/themes">See all {THEMES.length} themes</a>
    </Screen>
  )
}

export function SyncLine() {
  const { pending, offline, error } = useSync()
  const n = `${pending} change${pending > 1 ? 's' : ''}`
  const text = error || (offline ? `No signal? No problem. ${pending ? `I’ll sync ${n} later.` : 'Everything is saved on this phone.'}`
    : pending ? `Syncing ${n}…` : 'All synced.')
  return <p className="sync-line" role="status">{text}</p>
}

function Page({ s, title, children }: { s: State; title: string; children: ReactNode }) {
  return <Screen t={s.theme} back title={title}><div className="form">{children}</div></Screen>
}

/** Profile picture: a photo, an emoji, a Plico face, or just initials. */
function AvatarPicker({ s }: { s: State }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const cur = s.user?.image ?? ''
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('')
    try { await fn(); await refreshUser() } catch (e) { setErr(msg(e)) } finally { setBusy(false) }
  }
  const set = (image: string | null) => run(async () => { const r = await authClient.updateUser({ image }); if (r.error) throw new Error(r.error.message) })
  return (
    <section className="avatar-pick" aria-label="Profile picture" aria-busy={busy}>
      <Avatar name={s.me.name} image={cur} size={96} />
      <div className="avatar-actions">
        <label className="btn-sm">
          <input type="file" accept="image/*" className="sr-only" disabled={busy}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(() => uploadImage('/api/me/avatar', f, 512)) }} />
          <Icon n="plus" size={16} />Photo
        </label>
        <button type="button" className="btn-sm ghost" disabled={busy} onClick={() => void set(`plico:${randomSeed()}`)}>{cur.startsWith('plico:') ? 'Another Plico' : 'Plico face'}</button>
        {cur && <button type="button" className="btn-sm ghost" disabled={busy} onClick={() => void set(null)}>Initials</button>}
      </div>
      <div className="emoji-grid" role="radiogroup" aria-label="Emoji">
        {EMOJI.map(x => <button type="button" key={x} role="radio" aria-checked={cur === `emoji:${x}`} disabled={busy} onClick={() => void set(`emoji:${x}`)}>{x}</button>)}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  )
}

export function ProfilePage({ s }: { s: State }) {
  return (
    <Page s={s} title="Profile">
      <AvatarPicker s={s} />
      <label className="field"><span>Name</span><input value={s.me.name} maxLength={40} autoComplete="name" onChange={e => update(d => { d.me.name = e.target.value })} /></label>
      <label className="field"><span>Phone</span>
        <input type="tel" value={s.me.phone ?? ''} placeholder="+91 98765 43210" autoComplete="tel" aria-invalid={!!s.me.phone && !isPhone(s.me.phone)}
          onChange={e => update(d => { d.me.phone = e.target.value })} />
        <small>Shown to people in your groups so they can reach you.</small>
      </label>
      <label className="field"><span>UPI ID</span>
        <input value={s.me.upi} placeholder="name@okhdfcbank" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          aria-invalid={!!s.me.upi && !isVpa(s.me.upi)} onChange={e => update(d => { d.me.upi = e.target.value.trim() })} />
        <small>Friends pay you here. It appears on your pay links and QR codes.</small>
      </label>
    </Page>
  )
}

export function AppearancePage({ s }: { s: State }) {
  return <Page s={s} title="Appearance"><ThemePicker value={s.theme} onChange={t => update(d => { d.theme = t })} /><small>Each group can also have its own theme in its settings.</small></Page>
}

export function RemindersPage({ s }: { s: State }) {
  return (
    <Page s={s} title="Reminders">
      <div className="seg" role="radiogroup" aria-label="Reminder tone">
        {(['normal', 'gentle', 'shameless'] as Tone[]).map(t => (
          <button type="button" key={t} role="radio" aria-checked={s.tone === t} className={s.tone === t ? 'on' : ''} onClick={() => update(d => { d.tone = t })}>
            {{ normal: 'Normal', gentle: 'Friendly', shameless: 'Playful' }[t]}
          </button>
        ))}
      </div>
      <p className="preview-msg">{TONES[s.tone]('₹840', 'Arjun', "Goa '26")}</p>
    </Page>
  )
}

export function SecurityPage({ s }: { s: State }) {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { authClient.listAccounts().then(r => setHasPassword(!!r.data?.some(a => a.providerId === 'credential')), () => setHasPassword(true)) }, [])
  const changeEmail = async () => {
    const r = await authClient.changeEmail({ newEmail: newEmail.trim(), callbackURL: `${origin()}#/verified` }).catch(e => ({ error: { message: msg(e) } }))
    setNote(r.error ? { ok: false, text: r.error.message || 'Couldn’t change email.' }
      : { ok: true, text: s.user?.emailVerified ? `Confirm the change from the email we sent to ${s.user.email}.` : `Check ${newEmail.trim()} to verify it.` })
    if (!r.error) setNewEmail('')
  }
  const changePassword = async () => {
    const r = await authClient.changePassword({ currentPassword: cur, newPassword: next, revokeOtherSessions: true }).catch(e => ({ error: { message: msg(e) } }))
    setNote(r.error ? { ok: false, text: r.error.message || 'Couldn’t change password.' } : { ok: true, text: 'Password changed. Other devices were signed out.' })
    if (!r.error) { setCur(''); setNext('') }
  }
  return (
    <Page s={s} title="Email and password">
      <h2 className="form-h">Email</h2>
      <p>{s.user?.email}</p>
      <form className="form" onSubmit={e => { e.preventDefault(); void changeEmail() }}>
        <label className="field"><span>New email</span><input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} autoComplete="email" autoCapitalize="none" required /></label>
        <button className="btn secondary">Change email</button>
      </form>
      <h2 className="form-h">Password</h2>
      {hasPassword === false ? <p className="muted-p">You sign in with Google, so there’s no Plico password to change.</p> : (
        <form className="form" onSubmit={e => { e.preventDefault(); void changePassword() }}>
          <label className="field"><span>Current password</span><input type="password" value={cur} onChange={e => setCur(e.target.value)} autoComplete="current-password" required /></label>
          <label className="field"><span>New password</span><input type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" minLength={8} required /><small>At least 8 characters. Other devices will be signed out.</small></label>
          <button className="btn secondary">Change password</button>
        </form>
      )}
      {note && <p className={note.ok ? 'notice' : 'error'} role="status">{note.text}</p>}
    </Page>
  )
}

type Sess = { id: string; token: string; userAgent?: string | null; createdAt: string | Date; updatedAt: string | Date }
const device = (ua = '') => {
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const app = /Plico|wv\)/.test(ua) ? 'Plico app' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${app} on ${os}`
}

export function DevicesPage({ s }: { s: State }) {
  const [list, setList] = useState<Sess[] | null>(null)
  const [current, setCurrent] = useState('')
  const [err, setErr] = useState('')
  const load = async () => {
    const [l, me] = await Promise.all([authClient.listSessions(), authClient.getSession()])
    if (l.error) return setErr('Couldn’t load your devices. Check your connection.')
    setList(l.data as Sess[])
    setCurrent(me.data?.session.id ?? '')
  }
  useEffect(() => { void load() }, [])
  const revoke = async (token: string) => { await authClient.revokeSession({ token }); void load() }
  const others = async () => { await authClient.revokeOtherSessions(); void load() }
  return (
    <Page s={s} title="Devices">
      {!list ? <p className="muted-p">{err || 'Loading…'}</p> : <>
        <ol className="ledger">
          {list.map(x => (
            <li key={x.id} className="row-in">
              <span className="grow"><strong>{device(x.userAgent ?? '')}</strong><small>{x.id === current ? 'This device' : `Active ${new Date(x.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}</small></span>
              {x.id !== current && <button className="btn-sm ghost" onClick={() => void revoke(x.token)}>Sign out</button>}
            </li>
          ))}
        </ol>
        {list.length > 1 && <button className="btn secondary" onClick={() => void others()}>Sign out all other devices</button>}
      </>}
    </Page>
  )
}

export function DeletePage({ s }: { s: State }) {
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const ask = async () => {
    const r = await authClient.deleteUser({ callbackURL: `${origin()}#/` }).catch(e => ({ error: { message: msg(e) } }))
    if (r.error) return setErr(r.error.message || 'Couldn’t start deletion. Try again.')
    setSent(true)
  }
  return (
    <Page s={s} title="Delete account">
      <p>Deleting your account signs you out everywhere and removes your profile.</p>
      <p className="muted-p">Groups you’re in stay for everyone else, with you as a guest, so their balances still add up. This can’t be undone.</p>
      {sent ? <p className="notice" role="status">We emailed {s.user?.email} a link to confirm. Open it on this device to finish.</p>
        : <button className="btn danger-btn" onClick={() => void ask()}>Email me a confirmation link</button>}
      {err && <p className="error" role="alert">{err}</p>}
    </Page>
  )
}

/** Opened from the confirmation email: finishes deletion with the token, using this device's session. */
export function DeleteConfirm({ s, token }: { s: State; token: string }) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const del = async () => {
    setBusy(true)
    const r = await authClient.deleteUser({ token }).catch(e => ({ error: { message: msg(e) } }))
    if (r.error) { setBusy(false); return setErr(r.error.message || 'This link expired. Start again from Account.') }
    await signOut()
    location.replace('#/')
  }
  return (
    <Page s={s} title="Delete account">
      <p>Delete the account for <strong>{s.user?.email}</strong> for good?</p>
      <button className="btn danger-btn" disabled={busy} onClick={() => void del()}>{busy ? 'Deleting…' : 'Delete my account'}</button>
      <button className="btn secondary" onClick={() => go('/')}>Keep my account</button>
      {err && <p className="error" role="alert">{err}</p>}
    </Page>
  )
}
