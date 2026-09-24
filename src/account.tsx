// Account: splash, welcome + sign-in flows, password reset, verification, the account hub and its pages, claim links.
import { useEffect, useState, type ReactNode } from 'react'
import { Capacitor } from '@capacitor/core'
import { inr, isVpa, type Kind, type Tone } from './logic'
import { update, type State } from './store'
import { api, isPhone, pull, refreshUser, signOut, signedIn, syncNow, uploadImage, useSync } from './sync'
import { API, authClient, token } from './auth-client'
import { THEMES, ensureFonts, theme, themeVars, type ThemeId } from './themes'
import { Icon, type IconName } from './icons'
import { Avatar, EMOJI, Ornament, Plico, Screen, ThemePicker, TONES, Wordmark, calm, go, randomSeed, useTicker } from './ui'
import { disablePush, enablePush, pushState, type PushState } from './push'
import { ClaimPreviewOut, InvitePreviewOut, NotifyOut, type NotifyPrefs, type ClaimPreview, type InvitePreview as InvitePreviewData } from './schema'

const origin = () => location.origin + location.pathname.replace(/index\.html$/, '')
const msg = (e: unknown, fallback = 'That didn’t work. Your balances are safe. Try again.') =>
  (e as { message?: string })?.message || fallback
const cleanUrl = (hash = '#/') => history.replaceState(null, '', location.pathname + hash)

// ---------- invite preview: who invited you, to what, before you sign up ----------
export function InvitePreview({ s, kind, code }: { s: State; kind: 'join' | 'claim'; code: string }) {
  const [p, setP] = useState<(InvitePreviewData & Partial<ClaimPreview>) | (ClaimPreview) | null>(null)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    fetch(`${API}/api/public/${kind === 'join' ? 'invites' : 'claim'}/${code}`).then(async r => {
      const j: unknown = await r.json().catch(() => ({}))
      const out = (kind === 'join' ? InvitePreviewOut : ClaimPreviewOut).safeParse(j)
      if (r.ok && out.success) setP(out.data); else setErr((j as { error?: string }).error ?? 'This invite link is no longer valid.')
    }, () => setErr('Can’t reach Plico. Check your connection and try again.'))
  }, [kind, code])
  const t = p?.group.theme ?? 'classic'
  useEffect(() => ensureFonts([t]), [t])
  if (ready || err) return <AuthFlow s={s} prefill={p?.prefill ?? undefined}
    notice={p ? `Sign in or create your account to join ${p.group.name}.` : `${err.replace(/\.?$/, '.')} You can still sign in.`} />
  if (!p) return <Splash />
  return (
    <div className="welcome invite" data-theme={t} style={themeVars(t)}>
      <div className="welcome-top">
        <Wordmark />
        <section className="invite-card" aria-label={`Invitation to ${p.group.name}`}>
          <Ornament t={t} />
          <span className="slip-kind invite-kind"><Icon n={p.group.kind} size={28} /></span>
          <p className="invite-by"><strong>{p.invitedBy}</strong> invited you{p.name ? <> as <strong>{p.name}</strong></> : null} to</p>
          <h1>{p.group.name}</h1>
          {'people' in p.group && <p className="invite-meta">{p.group.people === 1 ? `Just ${p.invitedBy} so far` : `${p.group.people} people`} splitting and settling here</p>}
        </section>
        <ul className="points">
          <li><Icon n="check" />See exactly who paid what, and who owes whom.</li>
          <li><Icon n="qr" />Settle by UPI, to a name you can see before you pay.</li>
          <li><Icon n="shield" />Every change is on the record, sealed so nobody can quietly rewrite it.</li>
        </ul>
      </div>
      <div className="welcome-actions">
        <button className="btn primary" onClick={() => setReady(true)}>Join {p.group.name}</button>
        <p className="legal-line center">Free to join. <a href={legalUrl('privacy')} target="_blank" rel="noopener">Privacy</a> · <a href={legalUrl('terms')} target="_blank" rel="noopener">Terms</a></p>
      </div>
    </div>
  )
}

// ---------- splash ----------
export function Splash() {
  return (
    <div className="splash" role="status" aria-label="Plico is starting">
      <Plico mood="settled" size={112} />
      <span className="splash-word">plico</span>
    </div>
  )
}

// ---------- Google and Apple: sign in, or connect to the signed-in account ----------
type Provider = 'google' | 'apple'
type Token = { token: string; nonce?: string; user?: { name: { firstName?: string; lastName?: string } } }

// Google blocks its sign-in page inside WebViews, so native apps use the platform SDK and hand the ID token over.
async function googleToken(webClientId: string | null, iosClientId: string | null): Promise<Token> {
  const { SocialLogin } = await import('@capgo/capacitor-social-login')
  await SocialLogin.initialize({ google: { webClientId: webClientId ?? undefined, iOSClientId: iosClientId ?? undefined, iOSServerClientId: webClientId ?? undefined, mode: 'online' } })
  const login = await SocialLogin.login({ provider: 'google', options: { scopes: ['email', 'profile'] } })
  const idToken = (login.result as { idToken?: string | null }).idToken
  if (!idToken) throw new Error('Google didn’t return a sign-in token.')
  return { token: idToken }
}

// Apple: iOS only, the system sheet.
async function appleToken(): Promise<Token> {
  const { SocialLogin } = await import('@capgo/capacitor-social-login')
  await SocialLogin.initialize({ apple: { clientId: 'app.plico' } })
  const nonce = crypto.randomUUID() // replay guard: the server checks it against the token
  const login = await SocialLogin.login({ provider: 'apple', options: { scopes: ['email', 'name'], nonce } })
  const res = login.result as { idToken?: string | null; profile?: { givenName: string | null; familyName: string | null } }
  if (!res.idToken) throw new Error('Apple didn’t return a sign-in token.')
  // Apple sends the name only on the very first sign-in, so pass it along.
  return { token: res.idToken, nonce, user: { name: { firstName: res.profile?.givenName ?? undefined, lastName: res.profile?.familyName ?? undefined } } }
}

const providerToken = (p: Provider, sync: { googleWebClientId: string | null; googleIosClientId: string | null }) =>
  p === 'apple' ? appleToken() : googleToken(sync.googleWebClientId, sync.googleIosClientId)

async function socialSignIn(p: Provider, sync: { googleWebClientId: string | null; googleIosClientId: string | null }) {
  if (!Capacitor.isNativePlatform()) {
    // Leaves the page; the boot session check signs us in when Google sends us back.
    const r = await authClient.signIn.social({ provider: p, callbackURL: `${origin()}#/` })
    if (r.error) throw new Error(r.error.message)
    return
  }
  const r = await authClient.signIn.social({ provider: p, idToken: await providerToken(p, sync) })
  if (r.error) throw new Error(r.error.message)
  const u = (r.data as { user?: Parameters<typeof signedIn>[0] }).user ?? (await authClient.getSession()).data?.user
  if (u) await signedIn(u)
}

/** Adds Google or Apple to the account you're signed in to, whatever email it uses (e.g. Apple's Hide My Email). */
async function socialLink(p: Provider, sync: { googleWebClientId: string | null; googleIosClientId: string | null }) {
  const r = Capacitor.isNativePlatform()
    ? await authClient.linkSocial({ provider: p, idToken: await providerToken(p, sync) })
    : await authClient.linkSocial({ provider: p, callbackURL: `${origin()}#/me/security`, errorCallbackURL: `${origin()}#/me/security` }) // web: leaves the page
  if (r.error) throw new Error(/already|another|different user/i.test(r.error.message ?? '')
    ? `That ${p === 'apple' ? 'Apple ID' : 'Google account'} already opens a different Plico account. Sign in there and delete it first, then connect it here.`
    : r.error.message)
}

// ---------- age and parental consent (DPDP Act 2023 s.9: under-18s need a parent's verifiable consent) ----------
type Age = 'adult' | 'teen' | 'child' | null
export const legalUrl = (page: 'privacy' | 'terms' | 'cookies' | 'delete-account') =>
  `${import.meta.env.VITE_PUBLIC_URL || location.origin}/${page}/${import.meta.env.DEV ? 'index.html' : ''}` // dev server doesn't serve folder index pages

async function saveAge(age: Age, guardian: string) {
  if (age !== 'adult' && age !== 'teen') throw new Error('Tell us how old you are.')
  await api('/api/me/age', { method: 'POST', body: JSON.stringify({ group: age, ...(age === 'teen' && { guardianEmail: guardian.trim() }) }) })
}

function AgeFields({ age, setAge, guardian, setGuardian }: { age: Age; setAge: (a: Age) => void; guardian: string; setGuardian: (g: string) => void }) {
  return <>
    <fieldset className="field">
      <legend>How old are you?</legend>
      <div className="seg" role="radiogroup" aria-label="How old are you">
        {([['adult', '18 or older'], ['teen', '13 to 17'], ['child', 'Under 13']] as const).map(([v, label]) =>
          <button type="button" key={v} role="radio" aria-checked={age === v} className={age === v ? 'on' : ''} onClick={() => setAge(v)}>{label}</button>)}
      </div>
      {age === 'child' && <small className="error">Plico is for people 13 and older. Ask a parent to add you to their group as a guest instead.</small>}
    </fieldset>
    {age === 'teen' && (
      <label className="field"><span>Parent or guardian’s email</span>
        <input type="email" value={guardian} onChange={e => setGuardian(e.target.value)} autoCapitalize="none" required />
        <small>We’ll ask them to agree before you can use Plico. The law in India needs a parent’s consent for anyone under 18.</small>
      </label>
    )}
  </>
}

/** Accounts that never said their age (Google sign-in, older accounts) answer once. */
export function AgeGate({ s }: { s: State }) {
  const [age, setAge] = useState<Age>(null)
  const [guardian, setGuardian] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    setBusy(true); setErr('')
    try { await saveAge(age, guardian); await refreshUser(); void syncNow() } catch (e) { setErr(msg(e)) } finally { setBusy(false) }
  }
  return (
    <Screen t={s.theme} title="One quick question">
      <form className="form auth" onSubmit={e => { e.preventDefault(); void go() }}>
        <p className="muted-p">We ask everyone once. People under 18 need a parent’s consent to use Plico.</p>
        <AgeFields age={age} setAge={setAge} guardian={guardian} setGuardian={setGuardian} />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy || !age || age === 'child'}>Continue</button>
        <button type="button" className="link center-link" onClick={() => void signOut()}>Sign out</button>
      </form>
    </Screen>
  )
}

/** A 13-17 year old waiting for their parent. Checks back whenever the app comes to the front. */
export function GuardianWait({ s }: { s: State }) {
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    const check = () => void refreshUser().then(u => { if ((u as { guardianConsentAt?: unknown } | undefined)?.guardianConsentAt) void syncNow() })
    const id = setInterval(check, 15000)
    window.addEventListener('focus', check)
    return () => { clearInterval(id); window.removeEventListener('focus', check) }
  }, [])
  const resend = async (to?: string) => {
    setErr(''); setNote('')
    try { await api('/api/me/guardian', { method: 'POST', body: JSON.stringify(to ? { email: to } : {}) }); await refreshUser(); setNote('Sent. Ask them to check their inbox (and spam).'); setEmail('') } catch (e) { setErr(msg(e)) }
  }
  return (
    <Screen t={s.theme} title="Almost there">
      <div className="form auth">
        <div className="hello"><Plico mood="thinking" size={56} /><p><strong>Waiting for your parent</strong>We emailed {s.user?.guardianEmail ?? 'your parent'}. Once they agree, Plico opens up here by itself.</p></div>
        {note && <p className="notice" role="status">{note}</p>}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn secondary" onClick={() => void resend()}>Send the email again</button>
        <label className="field"><span>Wrong email?</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="parent@example.com" autoCapitalize="none" /></label>
        <button className="btn secondary" disabled={!email.trim()} onClick={() => void resend(email.trim())}>Send to this email</button>
        <button className="link center-link" onClick={() => void signOut()}>Sign out</button>
      </div>
    </Screen>
  )
}

/** The parent's side, from the email link. Public: parents don't need an account. */
export function GuardianConsent({ token }: { token: string }) {
  const [child, setChild] = useState<{ name: string; email: string } | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [adult, setAdult] = useState(false)
  const [done, setDone] = useState<'' | 'yes' | 'no'>('')
  useEffect(() => { ensureFonts(['classic']); api<{ child: { name: string; email: string } }>(`/api/guardian/${token}`).then(r => setChild(r.child)).catch(e => setErr(msg(e))) }, [token])
  const decide = async (consent: boolean) => {
    if (!consent && !confirm(`Decline and delete ${child?.name}’s Plico account?`)) return
    setErr('')
    try { await api(`/api/guardian/${token}`, { method: 'POST', body: JSON.stringify({ consent, name: name.trim(), adult }) }); setDone(consent ? 'yes' : 'no') } catch (e) { setErr(msg(e)) }
  }
  return (
    <Screen t="classic" title="Parental consent">
      <div className="form auth">
        {done === 'yes' ? <><div className="hello"><Plico mood="settled" size={56} /><p><strong>Thank you</strong>{child?.name} can use Plico now. You can withdraw consent any time by writing to privacy@plico.space; their account will then be deleted.</p></div></>
        : done === 'no' ? <p className="notice">Declined. {child?.name}’s account and data have been deleted.</p>
        : !child ? <p className={err ? 'error' : 'muted-p'}>{err || 'Opening…'}</p> : <>
          <h1 className="q">{child.name} would like to use Plico</h1>
          <p className="muted-p">{child.name} ({child.email}) signed up and said they are between 13 and 17. Plico keeps track of shared expenses with friends and family and helps settle up over UPI. It never moves money itself, shows no ads, and never sells or tracks data.</p>
          <p className="muted-p">With your consent Plico stores {child.name}’s name, email, the groups and expenses they add, and any photos they attach. Read the <a className="link" href={legalUrl('privacy')} target="_blank" rel="noopener">Privacy Policy</a> for everything.</p>
          <label className="field"><span>Your full name</span><input value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>
          <label className="check"><input type="checkbox" checked={adult} onChange={e => setAdult(e.target.checked)} />I am {child.name}’s parent or legal guardian, and I am 18 or older.</label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn primary" disabled={!adult || name.trim().length < 2} onClick={() => void decide(true)}>I agree</button>
          <button className="btn secondary" onClick={() => void decide(false)}>Decline and delete the account</button>
        </>}
      </div>
    </Screen>
  )
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

export function AuthFlow({ s, notice, prefill, start }: { s: State; notice?: string; prefill?: string; start?: Step }) {
  const sync = useSync()
  const returning = !!s.user
  const [step, setStep] = useState<Step>(start ?? (returning ? 'signin' : 'welcome'))
  const [name, setName] = useState(s.me.name)
  const [email, setEmail] = useState(s.user?.email ?? prefill ?? '')
  const [password, setPassword] = useState('')
  const [age, setAge] = useState<Age>(null)
  const [guardian, setGuardian] = useState('')
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
    if (step === 'signup' && (!age || age === 'child')) throw new Error(age === 'child' ? 'Plico is for people 13 and older.' : 'Tell us how old you are.')
    const r = step === 'signup'
      ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password, callbackURL: `${origin()}#/verified` })
      : await authClient.signIn.email({ email: email.trim(), password })
    if (r.error) throw new Error(
      r.error.status === 401 ? 'That email and password don’t match. If you used Google or Apple before, continue with it, or reset your password to add one.'
      : r.error.status === 422 ? 'This email already has a Plico account. Sign in instead, with Google, Apple or your password (or reset it to set one).'
      : r.error.message)
    if (step === 'signup') await saveAge(age, guardian)
    await signedIn(r.data.user)
    if (step === 'signup') await refreshUser() // pick up the age just saved
  })
  const google = () => run(() => socialSignIn('google', sync))
  const apple = () => run(() => socialSignIn('apple', sync))
  // App Store 4.8: an iOS app offering Google sign-in must offer Sign in with Apple too, at least as prominently.
  const showApple = Capacitor.getPlatform() === 'ios'
  const social = <>
    {showApple && <button className="btn apple" disabled={busy} onClick={() => void apple()}><AppleLogo />Sign in with Apple</button>}
    {sync.google && <button className="btn google" disabled={busy} onClick={() => void google()}><GoogleG />Continue with Google</button>}
  </>
  const hasSocial = showApple || sync.google
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
          {social}
          <button className="btn primary" onClick={() => to('signup')}>Create an account</button>
          <button className="btn secondary" onClick={() => to('signin')}>I already have an account</button>
          {err && <p className="error" role="alert">{err}</p>}
          <p className="legal-line center"><a href={legalUrl('privacy')} target="_blank" rel="noopener">Privacy</a> · <a href={legalUrl('terms')} target="_blank" rel="noopener">Terms</a></p>
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
          {hasSocial && step !== 'forgot' && <>
            {social}
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
            {step === 'signup' && <AgeFields age={age} setAge={setAge} guardian={guardian} setGuardian={setGuardian} />}
            {step === 'signup' && <p className="legal-line">By creating an account you agree to the <a href={legalUrl('terms')} target="_blank" rel="noopener">Terms</a> and <a href={legalUrl('privacy')} target="_blank" rel="noopener">Privacy Policy</a>.</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <button className="btn primary" disabled={busy || (step === 'signup' && age === 'child')}>
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

const AppleLogo = () => (
  <svg width="18" height="20" viewBox="0 0 814 1000" aria-hidden fill="currentColor">
    <path d="M788 341c-6 4-108 62-108 190 0 149 131 201 135 203-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-164-40c-76 0-104 41-166 41s-106-57-156-127C46 792 0 666 0 546c0-193 125-295 249-295 66 0 121 43 162 43 40 0 102-46 177-46 29 0 131 3 200 93zM555 161c31-37 53-88 53-139 0-7-1-14-2-20-51 2-111 34-147 76-28 32-55 83-55 135 0 8 1 15 2 18 3 1 9 2 14 2 45 0 103-31 135-72z" />
  </svg>
)

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
    <Screen t={s.theme} title="Account" fab="/add">
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
        <Row icon="bell" title="Notifications" sub="Payments, group activity, reminders" to="/me/notify" />
        <Row icon="lock" title="Privacy and data" sub="AI reading, download your data, policies" to="/me/privacy" />
        <Row icon="lock" title="Sign-in and security" sub="Google, Apple, email and password" to="/me/security" />
        <Row icon="phone" title="Devices" sub="Where you’re signed in" to="/me/devices" />
      </ol>
      <SyncLine />
      <button className="btn secondary" onClick={out}>Sign out</button>
      <ol className="ledger danger-zone"><Row icon="trash" title="Delete account" to="/me/delete" danger /></ol>
      {import.meta.env.DEV && <a className="link center-link" href="#/themes">See all {THEMES.length} themes</a>}
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

export function PrivacyPage({ s }: { s: State }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const setAi = async (consent: boolean) => {
    setBusy(true); setErr('')
    try { await api('/api/me/ai', { method: 'POST', body: JSON.stringify({ consent }) }); await refreshUser() } catch (e) { setErr(msg(e)) } finally { setBusy(false) }
  }
  const download = async () => {
    setBusy(true); setErr('')
    try {
      const res = await fetch(API + '/api/me/export', { credentials: 'include', headers: token.get() ? { Authorization: `Bearer ${token.get()}` } : {} })
      if (!res.ok) throw new Error('Couldn’t prepare your data. Try again.')
      const file = new File([await res.blob()], 'plico-export.json', { type: 'application/json' })
      if (Capacitor.isNativePlatform() && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Your Plico data' })
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000) }
    } catch (e) { if ((e as Error).name !== 'AbortError') setErr(msg(e)) } finally { setBusy(false) }
  }
  return (
    <Page s={s} title="Privacy and data">
      <h2 className="form-h">AI reading</h2>
      <label className="check"><input type="checkbox" checked={!!s.user?.ai} disabled={busy} onChange={e => void setAi(e.target.checked)} />Read receipts, screenshots and typed expenses with AI</label>
      <p className="muted-p">When on, the photo or sentence and the first names in that group go to OpenRouter, which runs an OpenAI model to read it. Only providers that don’t store or train on it are used. When off, typing still works on your phone and nothing is sent.</p>
      <h2 className="form-h">Your data</h2>
      <button className="btn secondary" disabled={busy} onClick={() => void download()}>Download my data</button>
      <p className="muted-p">A JSON file with your account, groups, expenses and sign-in history. To delete everything, use Delete account.</p>
      {s.user?.ageGroup === 'teen' && <p className="notice">A parent or guardian gave consent for this account. They can withdraw it at privacy@plico.space.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <h2 className="form-h">Policies</h2>
      <ul className="legal-links">
        <li><a className="link" href={legalUrl('privacy')} target="_blank" rel="noopener">Privacy Policy</a></li>
        <li><a className="link" href={legalUrl('terms')} target="_blank" rel="noopener">Terms of Use</a></li>
        <li><a className="link" href={legalUrl('cookies')} target="_blank" rel="noopener">Cookies and storage</a></li>
        <li><a className="link" href="mailto:privacy@plico.space">privacy@plico.space</a> (privacy questions and grievances)</li>
      </ul>
    </Page>
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

/** Pushes on this device, what's worth a push, and how reminders to others sound. */
export function NotificationsPage({ s }: { s: State }) {
  const sync = useSync()
  const [state, setState] = useState<PushState | null>(null)
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { void pushState(sync.push).then(setState, () => setState('unsupported')) }, [sync.push])
  useEffect(() => { void api('/api/me/notify').then(r => setPrefs(NotifyOut.parse(r).prefs), () => setErr('Couldn’t load your settings. Check your connection.')) }, [])
  const toggle = async (on: boolean) => {
    setBusy(true); setErr('')
    try {
      if (on) { if (!(await enablePush(sync.push))) setErr('Notifications are blocked for Plico. Allow them in your settings, then try again.') }
      else await disablePush()
      setState(await pushState(sync.push))
    } catch (e) { setErr(msg(e)) } finally { setBusy(false) }
  }
  const set = async (k: keyof NotifyPrefs, v: boolean) => {
    if (!prefs) return
    const before = prefs
    setPrefs({ ...prefs, [k]: v })
    try { setPrefs(NotifyOut.shape.prefs.parse((await api<{ prefs: unknown }>('/api/me/notify', { method: 'PUT', body: JSON.stringify({ [k]: v }) })).prefs)) }
    catch { setPrefs(before); setErr('Couldn’t save that. Check your connection.') }
  }
  const Pref = ({ k, title, sub }: { k: keyof NotifyPrefs; title: string; sub: string }) => (
    <label className="check pref"><input type="checkbox" checked={!!prefs?.[k]} disabled={!prefs} onChange={e => void set(k, e.target.checked)} /><span><strong>{title}</strong><small>{sub}</small></span></label>
  )
  const device = {
    on: 'On for this device.',
    off: 'Off for this device.',
    blocked: `Blocked in your ${Capacitor.isNativePlatform() ? 'phone’s' : 'browser’s'} settings. Allow notifications for Plico there, then come back.`,
    unsupported: Capacitor.isNativePlatform() ? 'Notifications aren’t set up for this app yet.'
      : /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, add Plico to your Home Screen (Share, then Add to Home Screen) and open it from there.' : 'This browser can’t show notifications from Plico.',
  }
  return (
    <Page s={s} title="Notifications">
      <section className="notify-device" aria-live="polite">
        <Icon n="bell" />
        <p><strong>This device</strong><small>{state ? device[state] : 'Checking…'}</small></p>
        {(state === 'on' || state === 'off') && <button className={`btn-sm${state === 'on' ? ' ghost' : ''}`} disabled={busy} onClick={() => void toggle(state === 'off')}>{state === 'on' ? 'Turn off' : 'Turn on'}</button>}
      </section>
      {err && <p className="error" role="alert">{err}</p>}
      <fieldset className="field"><legend>Tell me about</legend>
        <Pref k="payments" title="Payments" sub="Someone paid you, or confirmed your payment. Sent right away." />
        <Pref k="activity" title="Group activity" sub="New expenses, changes to your share, people joining. Bundled every couple of minutes." />
        <Pref k="reminders" title="Reminders from friends" sub="When someone reminds you to settle up. At most once a day per group." />
        <Pref k="nudge" title="Weekly nudge" sub="Sunday morning, only if you’ve owed money for over a week." />
      </fieldset>
      <fieldset className="field"><legend>How</legend>
        <Pref k="quiet" title="Quiet at night" sub="Nothing between 10 pm and 8 am. It all arrives at 8." />
        <Pref k="amounts" title="Show amounts" sub="Include ₹ amounts on the lock screen." />
      </fieldset>
      <p className="legal-line">At most 8 a day, payments aside. Apple, Google or your browser’s push service delivers them.</p>
      <fieldset className="field"><legend>When you remind others on WhatsApp</legend>
        <div className="seg" role="radiogroup" aria-label="Reminder tone">
          {(['normal', 'gentle', 'shameless'] as Tone[]).map(t => (
            <button type="button" key={t} role="radio" aria-checked={s.tone === t} className={s.tone === t ? 'on' : ''} onClick={() => update(d => { d.tone = t })}>
              {{ normal: 'Normal', gentle: 'Friendly', shameless: 'Playful' }[t]}
            </button>
          ))}
        </div>
        <p className="preview-msg">{TONES[s.tone]('₹840', 'Arjun', "Goa '26")}</p>
      </fieldset>
    </Page>
  )
}

export function SecurityPage({ s }: { s: State }) {
  const sync = useSync()
  const [accts, setAccts] = useState<{ id: string; providerId: string }[] | null>(null) // how this account can sign in: credential, google, apple
  const ways = accts?.map(a => a.providerId) ?? null
  const [busy, setBusy] = useState('')
  const hasPassword = ways && ways.includes('credential')
  const loadWays = () => authClient.listAccounts().then(r => setAccts(r.data ?? []), () => setAccts([{ id: '', providerId: 'credential' }]))
  const connect = async (p: Provider, on: boolean) => {
    setBusy(p); setNote(null)
    try {
      if (on) await socialLink(p, sync)
      else { const r = await authClient.unlinkAccount({ accountId: accts!.find(a => a.providerId === p)!.id }); if (r.error) throw new Error(r.error.message) }
      await loadWays()
      setNote({ ok: true, text: on ? `Connected. ${p === 'apple' ? 'Sign in with Apple' : 'Continue with Google'} now opens this account.` : 'Removed. Your other ways to sign in still work.' })
    } catch (e) { setNote({ ok: false, text: msg(e) }) } finally { setBusy('') }
  }
  // Apple only exists on iPhone; still show it elsewhere if it's connected, so it can be removed.
  const methods = ([['google', 'Google', sync.google], ['apple', 'Apple', Capacitor.getPlatform() === 'ios']] as const)
    .filter(([id, , offered]) => offered || ways?.includes(id))
  const [newEmail, setNewEmail] = useState('')
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { void loadWays() }, [])
  const setPassword = async () => {
    const r = await authClient.requestPasswordReset({ email: s.user!.email, redirectTo: `${origin()}#/reset` }).catch(e => ({ error: { message: msg(e) } }))
    setNote(r.error ? { ok: false, text: r.error.message || 'Couldn’t send the link.' } : { ok: true, text: `We emailed ${s.user!.email} a link to set a password.` })
  }
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
    <Page s={s} title="Sign-in and security">
      <h2 className="form-h">Ways to sign in</h2>
      <p className="muted-p">Each one opens this same account, even if it uses a different email (like Apple’s Hide My Email).</p>
      {ways && <ul className="ways">
        <li><Icon n="lock" /><span><strong>Email and password</strong><small>{hasPassword ? s.user?.email : 'Not set up'}</small></span></li>
        {methods.map(([id, label]) => {
          const on = ways.includes(id)
          return <li key={id}>{id === 'google' ? <GoogleG /> : <AppleLogo />}<span><strong>{label}</strong><small>{on ? 'Connected' : 'Not connected'}</small></span>
            <button className="btn secondary" disabled={!!busy || (on && ways.length < 2)} title={on && ways.length < 2 ? 'Your only way in: add another first' : undefined}
              onClick={() => void connect(id, !on)}>{busy === id ? 'One moment…' : on ? 'Remove' : 'Connect'}</button></li>
        })}
      </ul>}
      <h2 className="form-h">Email</h2>
      <p>{s.user?.email}</p>
      <form className="form" onSubmit={e => { e.preventDefault(); void changeEmail() }}>
        <label className="field"><span>New email</span><input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} autoComplete="email" autoCapitalize="none" required /></label>
        <button className="btn secondary">Change email</button>
      </form>
      <h2 className="form-h">Password</h2>
      {ways && !hasPassword ? <>
        <p className="muted-p">No Plico password yet. Want one, to sign in with just your email too?</p>
        <button className="btn secondary" onClick={() => void setPassword()}>Email me a link to set a password</button>
      </> : (
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
  const [pushing, setPushing] = useState<string[]>([])
  useEffect(() => { void api('/api/me/notify').then(r => setPushing(NotifyOut.parse(r).sessions), () => {}) }, [])
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
              <span className="grow"><strong>{device(x.userAgent ?? '')}</strong><small>{x.id === current ? 'This device' : `Active ${new Date(x.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}{pushing.includes(x.id) ? ' · Notifications on' : ''}</small></span>
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
