// Push notifications on this device: ask, register with the server, open what a tap points at.
// Web: the service worker's Push API (VAPID). Phones: @capacitor/push-notifications (APNs on iPhone, FCM on Android).
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { api, useSync } from './sync'

const native = Capacitor.isNativePlatform()
const platform = Capacitor.getPlatform() as 'web' | 'ios' | 'android'
const TKEY = 'plico-push-token', ASKED = 'plico-push-asked'
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone
type Channels = ReturnType<typeof useSync>['push']

export type PushState = 'unsupported' | 'blocked' | 'off' | 'on'

/** Whether this device can get pushes, and whether it does. */
export async function pushState(ch: Channels): Promise<PushState> {
  if (native) {
    if (!(platform === 'ios' ? ch.ios : ch.android)) return 'unsupported'
    const p = await PushNotifications.checkPermissions()
    return p.receive === 'denied' ? 'blocked' : p.receive === 'granted' && localStorage.getItem(TKEY) ? 'on' : 'off'
  }
  // The service worker only runs in production builds (and in the installed app on iPhone, iOS 16.4+).
  if (!ch.web || !('serviceWorker' in navigator) || !('PushManager' in window) || !(await navigator.serviceWorker.getRegistration())) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  return Notification.permission === 'granted' && sub ? 'on' : 'off'
}

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0))

/** Ask (the OS prompt) and register. Resolves true when this device will get pushes. */
export async function enablePush(ch: Channels): Promise<boolean> {
  localStorage.setItem(ASKED, String(Date.now()))
  if (native) {
    let p = await PushNotifications.checkPermissions()
    if (p.receive === 'prompt' || p.receive === 'prompt-with-rationale') p = await PushNotifications.requestPermissions()
    if (p.receive !== 'granted') return false
    const token = await new Promise<string>((ok, no) => void (async () => {
      const off = () => h.forEach(x => void x.remove())
      const h = [
        await PushNotifications.addListener('registration', t => { off(); ok(t.value) }),
        await PushNotifications.addListener('registrationError', e => { off(); no(new Error(e.error)) }),
      ]
      await PushNotifications.register()
    })().catch(no))
    await api('/api/me/push-devices', { method: 'POST', body: JSON.stringify({ platform, token, tz: tz() }) })
    localStorage.setItem(TKEY, token)
    return true
  }
  if (!ch.web || (await Notification.requestPermission()) !== 'granted') return false
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(ch.web) })
  const { endpoint, keys } = sub.toJSON()
  await api('/api/me/push-devices', { method: 'POST', body: JSON.stringify({ platform: 'web', token: endpoint, keys, tz: tz() }) })
  localStorage.setItem(TKEY, endpoint!)
  return true
}

/** Stop pushes to this device (the rest of your devices keep theirs). */
export async function disablePush() {
  const token = localStorage.getItem(TKEY)
  if (native) await PushNotifications.unregister().catch(() => {})
  else await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe().catch(() => false)
  localStorage.removeItem(TKEY)
  if (token) await api('/api/me/push-devices', { method: 'DELETE', body: JSON.stringify({ token }) }).catch(() => {})
}

/** At launch, signed in: re-register if pushes are on (tokens rotate, sign-ins change, you may have travelled),
 *  and open whatever a tapped push points at. */
let listening = false
export async function resumePush(ch: Channels, open: (url: string) => void) {
  if (!listening) {
    listening = true
    if (native) void PushNotifications.addListener('pushNotificationActionPerformed', a => { const u = a.notification.data?.url; if (typeof u === 'string' && u.startsWith('#/')) open(u) })
    else navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open' && typeof e.data.url === 'string') open(e.data.url) })
  }
  if ((await pushState(ch).catch(() => 'unsupported')) === 'on') await enablePush(ch).catch(() => {})
}

/** The in-app ask shows at a moment that earns it, at most once a fortnight, and never after a yes or a block. */
export const mayAsk = () => Date.now() - Number(localStorage.getItem(ASKED) ?? 0) > 14 * 864e5
export const notNow = () => localStorage.setItem(ASKED, String(Date.now()))
