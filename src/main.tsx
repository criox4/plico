import { createRoot } from 'react-dom/client'
import { LazyMotion, MotionConfig } from 'motion/react'
import { Capacitor } from '@capacitor/core'
import App from './App'
import { startSync } from './sync'
import { hydrate } from './store'
import { startShareIntake } from './share'
import { startWidget } from './widget'
import './styles.css'

void hydrate().then(() => {
  startSync()
  startShareIntake()
  startWidget()
  // Motion: the m components render at once and animate once their features arrive; the OS's reduce-motion setting
  // turns movement into fades everywhere. strict: a full motion component here would undo the small bundle.
  createRoot(document.getElementById('root')!).render(
    <LazyMotion features={() => import('./motion-features').then(r => r.default)} strict>
      <MotionConfig reducedMotion="user"><App /></MotionConfig>
    </LazyMotion>,
  )
})

// Native apps ship their assets locally; only the web build needs the offline worker.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !Capacitor.isNativePlatform()) navigator.serviceWorker.register('/sw.js')
