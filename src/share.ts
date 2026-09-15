// Things shared into Plico from other apps (a UPI screenshot, a Swiggy order, a bit of text), held until
// the add screen picks them up. Web: the service worker stashes them (Web Share Target). Android/iOS: the
// share-target plugin (Android intent, iOS Share Extension via an App Group).
import { Capacitor } from '@capacitor/core'

export type Shared = { text?: string; image?: Blob }
let pending: Shared | null = null
let ready: Promise<void> = Promise.resolve()
export const takeShared = async () => { await ready; const p = pending; pending = null; return p }

export function startShareIntake() {
  if (Capacitor.isNativePlatform()) {
    void import('@capgo/capacitor-share-target').then(({ CapacitorShareTarget }) =>
      CapacitorShareTarget.addListener('shareReceived', async ev => {
        const f = ev.files?.find(x => x.mimeType?.startsWith('image/'))
        const image = f ? await fetch(f.uri.startsWith('data:') ? f.uri : Capacitor.convertFileSrc(f.uri)).then(r => r.blob()).catch(() => undefined) : undefined
        pending = { text: ev.texts?.join('\n') || ev.title || undefined, image }
        location.hash = '#/add/shared'
      }))
  } else if (location.hash.startsWith('#/add/shared') && 'caches' in window) {
    ready = (async () => {
      const c = await caches.open('plico-share')
      const [img, txt] = await Promise.all([c.match('/shared/image'), c.match('/shared/text')])
      pending = { image: img ? await img.blob() : undefined, text: txt ? await txt.text() : undefined }
      await Promise.all([c.delete('/shared/image'), c.delete('/shared/text')])
    })().catch(() => {})
  }
}
