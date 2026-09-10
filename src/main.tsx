import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import App from './App'
import { startSync } from './sync'
import './styles.css'

startSync()
createRoot(document.getElementById('root')!).render(<App />)

// Native apps ship their assets locally; only the web build needs the offline worker.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !Capacitor.isNativePlatform()) navigator.serviceWorker.register('/sw.js')
