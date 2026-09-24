// The API contract, in one place: every request the app sends and every response it reads, as Zod schemas.
// The server validates requests with these; the app takes its types from them (z.infer) and checks the responses
// that could corrupt its local copy (sync, conflicts, the audit log). zod/mini keeps the phone bundle small.
import * as z from 'zod/mini'
import { isVpa } from './logic'
import { THEMES, type ThemeId } from './themes'

// ---------- building blocks ----------
export const Id = z.string().check(z.regex(/^[\w:-]{1,64}$/))
export const Kind = z.enum(['trip', 'home', 'couple', 'friends', 'office', 'family', 'direct'])
export const Theme = z.enum(THEMES.map(t => t.id) as [ThemeId, ...ThemeId[]])
export const Day = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/))
export const Paise = z.int().check(z.minimum(0), z.maximum(2_000_000_000))
const Money = z.record(Id, Paise)
const text = (max: number, min = 1) => z.string().check(z.trim(), z.minLength(min), z.maxLength(max))
const Emoji = z.string().check(z.regex(/^(?=.*\p{Extended_Pictographic})\S{1,16}$/u))
export const FileName = z.string().check(z.regex(/^[0-9a-f-]{36}\.(jpg|png|webp)$/))
const isEmail = (v: string) => z.email().safeParse(v).success
const Upi = z.nullish(z.string().check(z.trim(), z.maxLength(256), z.refine(v => !v || isVpa(v), 'Not a valid UPI ID')))
const Email = z.nullish(z.string().check(z.trim(), z.toLowerCase(), z.maxLength(254), z.refine(v => !v || isEmail(v), 'Not a valid email')))
const Phone = z.nullish(z.string().check(z.trim(), z.maxLength(20), z.refine(v => !v || /^\+?[0-9 ()-]{7,20}$/.test(v), 'Not a valid phone number')))
export const GuardianEmail = z.string().check(z.trim(), z.toLowerCase(), z.maxLength(254), z.refine(isEmail, 'Enter your parent’s email'))
/** JSON dates arrive as ISO strings. */
const When = z.string()

// ---------- requests ----------
export const GroupIn = z.object({
  name: text(60), kind: Kind, theme: Theme, track: z.optional(z.boolean()), emoji: z.nullish(Emoji), cover: z.nullish(FileName), selfId: Id,
})
export const MemberIn = z.object({ name: text(60), upi: Upi, email: Email, phone: Phone })
export const ExpenseIn = z.object({
  title: text(120), cat: z.string().check(z.maxLength(20)), date: Day, amount: Paise.check(z.minimum(1)),
  paid: Money, owed: Money,
  mode: z.nullish(z.enum(['equal', 'exact', 'percent', 'shares'])), input: z.nullish(z.record(Id, z.number())),
  settle: z.optional(z.boolean()), pending: z.optional(z.boolean()), rejected: z.optional(z.boolean()), receipt: z.nullish(FileName),
  repeat: z.nullish(z.object({ next: Day, day: z.int().check(z.minimum(1), z.maximum(31)) })),
  /** The version this edit started from: null for a new expense. Absent only from pre-versioning clients (last write wins). */
  base: z.nullish(z.int().check(z.minimum(0))),
  /** "Restore this version" from the history screen. */
  revertOf: z.optional(z.int().check(z.minimum(1))),
})
export const ReadIn = z.object({
  text: z.optional(text(500)),
  image: z.optional(z.string().check(z.regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/), z.maxLength(7_000_000))),
  groupId: z.optional(Id), today: Day,
}).check(z.refine(b => !!(b.text || b.image), 'Send a sentence or a photo'))
export const AgeIn = z.object({ group: z.enum(['adult', 'teen']), guardianEmail: z.optional(GuardianEmail) })
export const GuardianIn = z.object({ email: z.optional(GuardianEmail) })
export const ParentConsentIn = z.object({ consent: z.boolean(), name: z.optional(text(80, 2)), adult: z.optional(z.boolean()) })
export const AiConsentIn = z.object({ consent: z.boolean() })
export const InviteResendIn = z.object({ email: z.optional(z.boolean()) })
export const FriendIn = z.object({ email: z.email().check(z.maxLength(254)), name: text(60) })
export const SeenIn = z.object({ at: z.iso.datetime() })
/** Web Push endpoints must belong to a browser's push service: the server POSTs to them. */
const PUSH_HOSTS = /^https:\/\/([\w-]+\.)*(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)\//
export const PushDeviceIn = z.object({
  platform: z.enum(['web', 'ios', 'android']),
  token: z.string().check(z.minLength(8), z.maxLength(2048)),
  keys: z.optional(z.object({ p256dh: z.string().check(z.maxLength(200)), auth: z.string().check(z.maxLength(100)) })),
  tz: z.optional(z.string().check(z.maxLength(64))),
}).check(z.refine(b => b.platform !== 'web' || (!!b.keys && PUSH_HOSTS.test(b.token)), 'Not a browser push subscription'))
export const PushTokenIn = z.object({ token: z.string().check(z.minLength(8), z.maxLength(2048)) })
const on = z.optional(z.boolean())
export const NotifyIn = z.object({ payments: on, activity: on, reminders: on, nudge: on, quiet: on, amounts: on })
export const RemindIn = z.object({ memberId: Id, amount: Paise.check(z.minimum(1)) })
export const Token = z.string().check(z.regex(/^[a-f0-9]{32}$/))
export const InviteCode = z.string().check(z.maxLength(40))

// ---------- responses ----------
/** One version of an expense, as history and conflicts see it. Member ids are server ids. */
export const Snap = z.object({
  title: z.string(), cat: z.string(), date: z.string(), amount: z.int(),
  settle: z.optional(z.boolean()), pending: z.optional(z.boolean()), rejected: z.optional(z.boolean()),
  receipt: z.nullish(z.string()), repeatNext: z.nullish(z.string()),
  shares: z.array(z.object({ memberId: z.string(), paid: z.int(), owed: z.int() })),
})
/** An expense snapshot as the audit stores it: a Snap plus how the split was entered, so it can be restored exactly. */
export const SnapFull = z.extend(Snap, {
  mode: z.nullish(z.enum(['equal', 'exact', 'percent', 'shares'])), input: z.nullish(z.record(z.string(), z.number())), repeatDay: z.nullish(z.int()),
})
export const ServerExpense = z.extend(Snap, {
  id: z.string(), mode: z.nullable(z.enum(['equal', 'exact', 'percent', 'shares'])), input: z.nullable(z.record(z.string(), z.number())),
  repeatDay: z.nullable(z.int()), version: z.int(), deletedAt: z.nullable(When), updatedAt: When,
})
export const ServerMember = z.object({
  id: z.string(), name: z.string(), upi: z.nullable(z.string()), userId: z.nullable(z.string()), email: z.nullable(z.string()),
  phone: z.nullable(z.string()), invitedAt: z.nullable(When), user: z.nullish(z.object({ image: z.nullable(z.string()), email: z.string() })),
})
export const ServerGroup = z.object({
  id: z.string(), name: z.string(), kind: Kind, theme: Theme, track: z.boolean(), emoji: z.nullable(z.string()), cover: z.nullable(z.string()),
  createdById: z.nullable(z.string()), members: z.array(ServerMember), expenses: z.array(ServerExpense),
  /** false: `expenses` holds only what changed since the cursor, deletions included. */
  full: z.boolean(),
})
export const GroupsOut = z.object({ now: When, groups: z.array(ServerGroup) })
export const SavedOut = z.object({ ok: z.literal(true), version: z.optional(z.int()), pending: z.optional(z.boolean()), ignored: z.optional(z.boolean()) })
export const ConflictOut = z.object({
  code: z.literal('conflict'), error: z.string(), theirs: z.nullable(ServerExpense), by: z.string(), at: z.nullish(When), action: z.optional(z.string()),
})

/** Before/after in the audit log: an expense Snap, or the changed fields of a person or the group. */
const Changed = z.nullable(z.record(z.string(), z.unknown()))
export const AuditEvent = z.object({
  groupId: z.string(), seq: z.int(), kind: z.string(), expenseId: z.nullable(z.string()), memberId: z.nullable(z.string()),
  version: z.nullable(z.int()), revertOf: z.nullable(z.int()), byId: z.nullable(z.string()), byName: z.string(), at: When,
  before: Changed, after: Changed, effect: z.record(z.string(), z.int()), prevHash: z.string(), hash: z.string(),
})
export const AuditOut = z.object({ head: z.object({ auditSeq: z.int(), auditHash: z.string() }), events: z.array(AuditEvent) })
export const ActivityEvent = z.extend(AuditEvent, {
  memberOf: z.string(), group: z.object({ name: z.string(), kind: z.string() }), byMe: z.boolean(), myEffect: z.int(),
})
export const ActivityOut = z.object({ events: z.array(ActivityEvent), unread: z.int(), next: z.nullable(When) })
export const UnreadOut = z.object({ unread: z.int() })

export const ReadOut = z.object({
  title: z.string(), amount: z.nullable(z.number()), cat: z.string(), date: z.nullable(z.string()), payer: z.nullable(z.string()),
  people: z.array(z.string()), items: z.array(z.object({ name: z.string(), amount: z.number() })), extras: z.number(),
})
export const InvitePreviewOut = z.object({ group: z.object({ name: z.string(), kind: Kind, theme: Theme, people: z.int() }), invitedBy: z.string() })
export const ClaimPreviewOut = z.object({
  group: z.object({ name: z.string(), kind: Kind, theme: Theme }), invitedBy: z.string(), name: z.string(), email: z.nullable(z.string()), prefill: z.nullable(z.string()),
})

export const NotifyOut = z.object({
  prefs: z.object({ payments: z.boolean(), activity: z.boolean(), reminders: z.boolean(), nudge: z.boolean(), quiet: z.boolean(), amounts: z.boolean() }),
  /** Sign-ins (session ids) that have a device registered for pushes. */
  sessions: z.array(z.string()),
})
export const RemindOut = z.object({ ok: z.literal(true) })
export const RemindLimitOut = z.object({ error: z.string(), code: z.enum(['limit', 'not-on-plico', 'square', 'tracking']), retryAt: z.nullish(When) })

export type GroupInput = z.input<typeof GroupIn>
export type MemberInput = z.input<typeof MemberIn>
export type ExpenseInput = z.input<typeof ExpenseIn>
export type Snap = z.infer<typeof Snap>
export type SnapFull = z.infer<typeof SnapFull>
export type ServerExpense = z.infer<typeof ServerExpense>
export type ServerGroup = z.infer<typeof ServerGroup>
export type Conflict = z.infer<typeof ConflictOut>
export type AuditEvent = z.infer<typeof AuditEvent>
export type ActivityEvent = z.infer<typeof ActivityEvent>
export type Read = z.infer<typeof ReadOut>
export type InvitePreview = z.infer<typeof InvitePreviewOut>
export type ClaimPreview = z.infer<typeof ClaimPreviewOut>
export type NotifyPrefs = z.infer<typeof NotifyOut>['prefs']
