// Pick one contact to add: the system's own picker, so Plico never asks to read the address book and nothing but the
// one contact chosen leaves it. Web: the Contact Picker API (Android Chrome). Native: see the platform pickers.
import { normPhone } from './logic'

export type Picked = { name?: string; phone?: string; email?: string }

type ContactsManager = { select: (props: string[], o?: { multiple?: boolean }) => Promise<{ name?: string[]; tel?: string[]; email?: string[] }[]> }
const web = () => (navigator as Navigator & { contacts?: ContactsManager }).contacts

export const canPickContact = () => !!web()

/** The picked contact with its first usable phone number (as normPhone) and email, or null if they cancelled. */
export async function pickContact(): Promise<Picked | null> {
  const c = web()
  if (!c) return null
  const [p] = await c.select(['name', 'tel', 'email'], { multiple: false })
  if (!p) return null
  return { name: p.name?.[0]?.trim() || undefined, phone: p.tel?.map(t => normPhone(t)).find(Boolean) ?? undefined, email: p.email?.[0]?.trim().toLowerCase() || undefined }
}
