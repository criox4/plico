// The front door at plico.space for signed-out web visitors: one real Plico screen plays the whole loop
// (add → who owes whom → pay by UPI → Sorted → on the record) as the story scrolls past it.
// Everything on the screen is a sample group, labelled as one; no users, numbers or quotes are invented.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { inr, upiLink } from './logic'
import { themeVars, ensureFonts, THEMES } from './themes'
import { Avatar, Denomination, Plico, Seal, Wordmark, calm, useQr } from './ui'
import { Icon, type IconName } from './icons'
import { legalUrl } from './account'

const PEOPLE = ['Rahul', 'Isha', 'Karan']
const EACH = 84000 // ₹840 in paise: a ₹3,360 dinner, four ways

const STEPS: { id: string; title: string; body: string }[] = [
  { id: 'add', title: 'Add it the way you’d say it.', body: 'Type “Dinner 3360 split 4”, scan the bill, or share a UPI screenshot, and Plico works out who had what. Typing works even with no signal.' },
  { id: 'owe', title: 'See who owes whom. Plainly.', body: 'No spreadsheets, no “outstanding liability”. Rahul owes you ₹840, and Plico keeps it to the fewest payments.' },
  { id: 'pay', title: 'Pay by UPI, to a name you can see.', body: 'Any UPI app, or the QR. The payee’s name and UPI ID sit above every payment, and they confirm it arrived.' },
  { id: 'sorted', title: 'Sorted.', body: 'When everyone’s even, the group snaps shut. Plico celebrates settling, never spending.' },
  { id: 'record', title: 'Every change, on the record.', body: 'Who added, changed or deleted what, and what it did to each balance. Sealed, so nobody can quietly rewrite it.' },
]

export function Landing() {
  const [step, setStep] = useState(0)
  const refs = useRef<(HTMLElement | null)[]>([])
  useEffect(() => ensureFonts(['classic']), [])
  // The chapter in the middle of the viewport drives the screen.
  useEffect(() => {
    const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && setStep(Number((e.target as HTMLElement).dataset.step))), { rootMargin: '-45% 0px -45% 0px' })
    refs.current.forEach(el => el && io.observe(el))
    return () => io.disconnect()
  }, [])
  const to = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth' })
  return (
    <div className="lp" data-theme="classic" style={themeVars('classic')}>
      <header className="lp-bar">
        <a href="#/" className="lp-brand" aria-label="Plico"><Wordmark /></a>
        <nav className="lp-links" aria-label="On this page">
          <button onClick={() => to('how')}>How it works</button>
          <button onClick={() => to('safety')}>Safety</button>
        </nav>
        <a className="lp-signin" href="#/signin">Sign in</a>
        <a className="btn primary lp-cta-sm" href="#/start">Get started</a>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <h1>Money together, sorted.</h1>
            <p className="lp-promise">Split trips, rent and dinners. Settle up over UPI. You enjoy the moment; Plico remembers the money.</p>
            <div className="lp-actions">
              <a className="btn primary" href="#/start">Get started</a>
              <a className="btn secondary" href="#/signin">I have an account</a>
            </div>
            <p className="lp-fine">Works in your browser, on any phone. Adding expenses is never paywalled.</p>
          </div>
          <div className="lp-hero-screen" aria-hidden><Phone step={0} still /></div>
        </section>

        <section className="lp-story" id="how" aria-label="How Plico works">
          <div className="lp-chapters">
            {STEPS.map((s, i) => (
              <article key={s.id} className={`lp-chapter${step === i ? ' on' : ''}`} data-step={i} ref={el => { refs.current[i] = el }}>
                <p className="lp-step" aria-hidden>{i + 1} / {STEPS.length}</p>
                <h2>{s.title}</h2>
                <p>{s.body}</p>
                <div className="lp-inline-screen" aria-hidden><Phone step={i} /></div>
              </article>
            ))}
          </div>
          <div className="lp-sticky" aria-hidden><Phone step={step} /></div>
        </section>

        <section className="lp-band" aria-labelledby="india">
          <h2 id="india">Made for how groups in India actually pay.</h2>
          <ul className="lp-facts">
            <Fact icon="qr" title="Any UPI app">GPay, PhonePe, Paytm or your bank: Plico hands over the payment with the name and amount filled in.</Fact>
            <Fact icon="send" title="Reminders that stay friendly">Nudge on WhatsApp in your tone, with a pay link nobody needs an app to open.</Fact>
            <Fact icon="check" title="Works offline">Add expenses in a cab or a hill station. They sync when you’re back, and clashes are yours to resolve, never lost.</Fact>
            <Fact icon="direct" title="Friends and groups">Trips, flats, couples, families, office lunches, or just the two of you.</Fact>
          </ul>
          <div className="lp-themes" aria-label="Every group can wear its own theme">
            {THEMES.slice(0, 12).map(t => (
              <span key={t.id} className="lp-theme" data-theme={t.id} style={themeVars(t.id)}><i style={{ background: t.c.accent }} />{t.name}</span>
            ))}
          </div>
          <p className="lp-caption">Every group can wear its own theme. What the money means never changes.</p>
        </section>

        <section className="lp-band lp-safety" id="safety" aria-labelledby="safe">
          <h2 id="safe">Safe by design.</h2>
          <ul className="lp-facts">
            <Fact icon="lock" title="The name before the payment">Every payment shows who you’re paying and their UPI ID first, and the payee confirms it arrived.</Fact>
            <Fact icon="shield" title="A sealed record">Each group’s log is chained, change after change, and your phone checks the seal itself.</Fact>
            <Fact icon="home" title="Kept in India">Your ledger is stored in Mumbai, under India’s data protection law, with parental consent for teens.</Fact>
            <Fact icon="user" title="No ads, no trackers">Plico doesn’t sell attention: no ad networks, no analytics following you around.</Fact>
          </ul>
        </section>

        <section className="lp-close" aria-labelledby="close">
          <Plico mood="settled" size={96} />
          <h2 id="close">Hi. I’m Plico.</h2>
          <p>I keep track of the awkward money stuff, so trips, rent and dinners stay fun.</p>
          <div className="lp-actions center">
            <a className="btn primary" href="#/start">Get started</a>
            <a className="btn secondary" href="#/start">Coming from Splitwise? Bring your groups</a>
          </div>
          <p className="lp-fine">Android and iPhone apps are on the way. Plico works in your browser today.</p>
        </section>
      </main>

      <footer className="lp-foot">
        <Wordmark />
        <nav aria-label="Legal">
          <a href={legalUrl('privacy')}>Privacy</a>
          <a href={legalUrl('terms')}>Terms</a>
          <a href={legalUrl('cookies')}>Cookies</a>
          <a href={legalUrl('delete-account')}>Delete account</a>
          <a href="mailto:privacy@plico.space">privacy@plico.space</a>
        </nav>
        <small>© 2026 Plico · Bengaluru, India</small>
      </footer>
    </div>
  )
}

function Fact({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return <li><Icon n={icon} /><p><strong>{title}</strong>{children}</p></li>
}

/** The live screen: a sample trip, one step of the loop at a time. */
function Phone({ step, still }: { step: number; still?: boolean }) {
  return (
    <div className={`lp-phone${still ? ' still' : ''}`} data-theme="goa" style={themeVars('goa')}>
      <div className="lp-phone-bar"><Icon n="back" size={18} /><strong>Goa ’26</strong><span className="lp-sample">Sample</span></div>
      <div className={`lp-phone-body${step === 3 ? ' center' : ''}`} key={step}>
        {step === 0 && <StepAdd still={still} />}
        {step === 1 && <StepOwe />}
        {step === 2 && <StepPay />}
        {step === 3 && <Seal t="goa" burst={!calm()} caption="Everyone’s even ✨" />}
        {step === 4 && <StepRecord />}
      </div>
    </div>
  )
}

function StepAdd({ still }: { still?: boolean }) {
  const line = 'Dinner at Gunpowder 3360 split 4'
  const [n, setN] = useState(still || calm() ? line.length : 0)
  useEffect(() => {
    if (n >= line.length) return
    const t = setTimeout(() => setN(n + 1), 38)
    return () => clearTimeout(t)
  }, [n])
  const done = n >= line.length
  return <>
    <div className="lp-type"><Icon n="send" size={16} /><span>{line.slice(0, n)}<i className="lp-caret" /></span></div>
    <div className={`lp-result${done ? ' in' : ''}`}>
      <p className="lp-result-title"><span className="cat"><Icon n="food" size={18} /></span><span><strong>Dinner at Gunpowder</strong><small>₹3,360 · you paid · split 4 ways</small></span></p>
      <p className="lp-each"><span className="money">{inr(EACH)}</span> each</p>
      <p className="lp-faces">{['You', ...PEOPLE].map(p => <Avatar key={p} name={p === 'You' ? 'Asha' : p} size={34} />)}</p>
    </div>
    <ol className={`lp-split${done ? ' in' : ''}`} aria-label="Who's in">
      {['You', ...PEOPLE].map(p => (
        <li key={p}><span>{p}</span><span className={`money ${p === 'You' ? '' : 'pos'}`}>{inr(EACH)}</span><small>{p === 'You' ? 'your share' : 'owes you'}</small></li>
      ))}
    </ol>
  </>
}

function StepOwe() {
  return <>
    <Denomination t="goa" amount={EACH * 3} line="You’re owed" caption="₹3,360 spent · your share ₹840" />
    <ol className="debts">
      {PEOPLE.map(p => (
        <li className="debt" key={p}>
          <span className="debt-flow"><span className="who">{p}</span><span className="flow-arrow"><Icon n="arrow" size={16} /></span><span className="who">You</span></span>
          <span className="money pos">{inr(EACH)}</span>
        </li>
      ))}
    </ol>
  </>
}

function StepPay() {
  const qr = useQr(upiLink('asha@okaxis', 'Asha Rao', EACH, 'Goa 26 settlement'))
  return (
    <section className="pay">
      <p className="pay-who">Rahul is paying</p>
      <p className="payee">Asha Rao</p>
      <code className="vpa">asha@okaxis</code>
      <p className="pay-amt"><span className="money pos">{inr(EACH)}</span></p>
      {qr && <div className="qr-plate lp-qr"><img src={qr} alt="" /></div>}
      <span className="btn primary lp-paybtn"><Icon n="send" size={18} />Pay {inr(EACH)} via UPI</span>
    </section>
  )
}

function StepRecord() {
  const rows: [string, string, string][] = [
    ['Karan', 'Karan paid you ₹840', 'Karan +₹840 · You −₹840'],
    ['Isha', 'Isha paid you ₹840', 'Isha +₹840 · You −₹840'],
    ['Rahul', 'Rahul paid you ₹840', 'Rahul +₹840 · You −₹840'],
    ['Isha', 'Isha changed “Dinner at Gunpowder”', 'Amount ₹3,200 → ₹3,360 · You +₹120'],
    ['Asha', 'You added “Dinner at Gunpowder”', 'You +₹2,400 · Rahul, Isha, Karan −₹800 each'],
  ]
  return <>
    <p className="verified lp-verified"><Icon n="shield" size={18} /><span><strong>Verified: 5 entries, unbroken</strong></span></p>
    <ol className="feed lp-feed">
      {rows.map(([who, line, moves]) => <li key={line}><Avatar name={who} size={28} /><span className="feed-body"><p><strong>{line}</strong></p><p className="moves">{moves}</p></span></li>)}
    </ol>
  </>
}
