import { createRoot } from 'react-dom/client'
import { ErrorBoundary, start as startCrashReports } from './sentry'
import { LazyMotion, MotionConfig } from 'motion/react'
import { Capacitor } from '@capacitor/core'
import App from './App'
import { startSync } from './sync'
import { hydrate } from './store'
import { startShareIntake } from './share'
import { startWidget } from './widget'
import './styles.css'

startCrashReports() // first, so a failure while starting up is reported too

void hydrate().then(() => {
  startSync()
  startShareIntake()
  startWidget()
  // Motion: the m components render at once and animate once their features arrive; the OS's reduce-motion setting
  // turns movement into fades everywhere. strict: a full motion component here would undo the small bundle.
  createRoot(document.getElementById('root')!).render(
    <LazyMotion features={() => import('./motion-features').then(r => r.default)} strict>
      <MotionConfig reducedMotion="user">
        <ErrorBoundary fallback={<Crashed />}><App /></ErrorBoundary>
      </MotionConfig>
    </LazyMotion>,
  )
})

// Native apps ship their assets locally; only the web build needs the offline worker.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !Capacitor.isNativePlatform()) navigator.serviceWorker.register('/sw.js')

/** What a crash looks like: calm, and one tap from working again. Your data is safe on the phone and on the server. */
function Crashed() {
  return (
    <main className="crashed" role="alert">
      <h1>Something went wrong.</h1>
      <p>Your groups and expenses are safe. Reloading usually fixes it.</p>
      <button className="btn primary" onClick={() => location.reload()}>Reload Plico</button>
    </main>
  )
}
