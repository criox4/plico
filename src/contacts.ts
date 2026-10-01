// Pick one contact to add: the system's own picker, so Plico never asks to read the address book and nothing but the
// one contact chosen leaves it. Web: the Contact Picker API (Android Chrome). Native: the local ContactPicker plugin
// (CNContactPickerViewController on iOS, ACTION_PICK on a phone number on Android, which can't see emails without a permission).
import { Capacitor, registerPlugin } from '@capacitor/core'
import { normPhone } from './logic'

export type Picked = { name?: string; phone?: string; email?: string }

type ContactsManager = { select: (props: string[], o?: { multiple?: boolean }) => Promise<{ name?: string[]; tel?: string[]; email?: string[] }[]> }
const web = () => (navigator as Navigator & { contacts?: ContactsManager }).contacts
const native = Capacitor.isNativePlatform()
const Native = registerPlugin<{ pick(): Promise<{ name?: string; phones?: string[]; email?: string }> }>('ContactPicker')

export const canPickContact = () => native || !!web()

/** The picked contact with its first usable phone number (as normPhone) and email, or null if they cancelled. */
export async function pickContact(): Promise<Picked | null> {
  if (native) {
    const p = await Native.pick()
    if (!p.name && !p.phones?.length && !p.email) return null // cancelled resolves empty
    return { name: p.name?.trim() || undefined, phone: p.phones?.map(t => normPhone(t)).find(Boolean) ?? undefined, email: p.email?.trim().toLowerCase() || undefined }
  }
  const c = web()
  if (!c) return null
  const [p] = await c.select(['name', 'tel', 'email'], { multiple: false })
  if (!p) return null
  return { name: p.name?.[0]?.trim() || undefined, phone: p.tel?.map(t => normPhone(t)).find(Boolean) ?? undefined, email: p.email?.[0]?.trim().toLowerCase() || undefined }
}
