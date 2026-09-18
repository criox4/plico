# Plico: architecture and technical decisions

Status as of 2026-09-27. What Plico is built with, why, where it's weak, and how it compares with Splitwise and the rest of the market. The plan for the next sync changes is in `PLAN.md` → *Sync v2*.

## Shape of the system

```
 Phone (PWA / Android / iOS: one React codebase)          Server (Hono on Node)                   Supabase (Mumbai)
┌──────────────────────────────────────────────┐  HTTPS  ┌──────────────────────────────┐        ┌─────────────────────┐
│ React UI  ─ store.ts (local state, saved on  │ ──────► │ /api/auth/*  Better Auth     │ ─────► │ Postgres            │
│             every edit)                      │         │ /api/*       Hono + Zod      │  pg    │ schema "splittr"    │
│ sync.ts   ─ diff → outbox → flush → pull     │ ◄────── │ Prisma 7 (adapter-pg)        │        │                     │
│ Capacitor ─ Google/Apple sign-in, share      │         │ storage.ts ─ REST ──────────────────► │ Storage buckets     │
│             target, widget, camera           │         │ ai.ts ─ OpenRouter (vision)  │        │ avatars / uploads   │
└──────────────────────────────────────────────┘         │ email.ts ─ ZeptoMail/Resend  │        └─────────────────────┘
                                                         └──────────────────────────────┘
```

Phones never talk to Supabase directly. Every read and write goes through our API.

## Stack

| Layer | Choice | Why | Considered instead |
|---|---|---|---|
| UI | React 19 + TypeScript 7, Vite 8, hand-written CSS with theme tokens | One codebase for web, Android, iOS; tiny dependency list (the app ships with 3 runtime UI deps) | React Native (second UI stack for web), Flutter (no real PWA) |
| Native shell | Capacitor 8 (Android + iOS via Swift Package Manager) | Wraps the same build; native plugins only where needed | Expo/RN, separate Kotlin + Swift apps (Splitwise's model) |
| Native plugins | `@capgo/capacitor-social-login` (Google, Apple), `@capgo/capacitor-share-target`, `@capacitor/preferences`; our own Android `AppWidgetProvider` and iOS WidgetKit + Share Extension | Share-to-Plico, home-screen balance widget, platform sign-in | |
| PWA | Hand-written service worker (`public/sw.js`), Web Share Target | Offline shell + share receipts from any app; no Workbox needed | Workbox |
| API | Hono 4 on Node (`@hono/node-server`), Zod 4 on every input | Small, fast, runs on Node, Vercel, or edge | Express, tRPC, Next.js API routes |
| Auth | Better Auth 1.7: email + password, Google, Apple; bearer tokens for native, httpOnly cookie for web | Self-hosted in our DB, no per-user fees, one account per email | Supabase Auth, Clerk, Firebase Auth |
| Database | Postgres (Supabase, Mumbai), Prisma 7 with the `pg` adapter; everything in schema `splittr` | Relational money data, constraints, transactions; India data residency | Firestore (Settle Up's choice), SQLite/Turso |
| Migrations | Hand-written SQL applied with `prisma migrate deploy` | The same database holds another app's `public` schema; never `migrate dev`/reset | |
| Files | Supabase Storage via its REST API, proxied by our server (`server/storage.ts`) | Indian ISPs sinkhole `*.supabase.co`; proxying also lets us check group membership on every photo | Signed URLs straight to Supabase (blocked for many Indian users) |
| AI capture | OpenRouter → `openai/gpt-6-luna`, strict JSON schema, `temperature 0`, `data_collection: deny` | Reads receipts, payment screenshots and sentences into a draft expense; nothing is saved without the user | On-device OCR (weak on Indian receipts), the HF `indian-receipt-parser-v2` model (evaluated, no hosted endpoint) |
| Email | ZeptoMail (India) first, Resend fallback, console in dev | Transactional mail from India; a fallback when one provider is down | SES |
| Hosting (planned) | Vercel for web + API on `plico.space` | One origin for cookie auth; env-var based config | Fly.io, Railway |
| Tests | Plain Node `assert` scripts (`npm test`: money, splits, parsing, themes) + Playwright scripts for end-to-end flows | Zero test-framework dependencies | Vitest/Jest |

## Key decisions

**Money is integer paise.** No floats anywhere. Splits use largest-remainder allocation so shares always add up to the total exactly. Every expense stores per-member `paid` and `owed`, with `sum(paid) = sum(owed) = amount`, checked on the client and again on the server (`sharesError`).

**Balances are derived, never stored.** A balance is a sum over expenses, recomputed when needed. There is no running total that two writers could corrupt, so concurrent adds from many phones can't make balances drift. Debt simplification (`simplify`) runs on the derived balances.

**Offline-first with an outbox.**
- Every edit is saved locally first.
- `sync.ts` diffs the state against the last synced snapshot and queues idempotent ops (PUT upserts and DELETEs with client-generated UUIDs).
- The queue is flushed in order.
- When it's empty, the app pulls the server's truth.

See *Sync* below.

**Settlements need the payee.** A payer records "I paid"; it stays *pending* (not counted) until the payee confirms, and the payee can say "Not yet". Only the payee's account can confirm or reject; the server enforces it. UPI payments can't be verified by a third-party app, so a human confirms.

**UPI by intent link + QR, no payment licence needed.**
- `upi://pay` with the payee's VPA and the amount, plus a QR code for the same link.
- The payee's name is shown prominently to prevent misdirected payments.
- Only the person themselves can change their UPI ID (an audit fix).

**One account per email.**
- Google or Apple with a verified matching email joins the existing account.
- An unverified email/password account that gets claimed this way loses its password and sessions, since anyone could have made it.
- Signed-in users can connect Google or Apple with a different email (e.g. Apple's Hide My Email) from Sign-in and security.

**Invites the Splitwise way.**
- Add a guest by name; optionally add an email (auto-links when that email is verified) or a phone (WhatsApp claim link; phones are never auto-linked).
- A group link/QR lets people join and pick which guest they are.

**Privacy and compliance by default.**
- India's DPDP Act 2023: age gate; 13–17 need a parent's consent by email; under-13 blocked.
- Explicit opt-in before any photo goes to AI.
- Data export; account deletion by email confirmation (shared groups keep you as a guest).
- iOS privacy manifests; no analytics or tracking SDKs.
- Legal pages under `public/`; details in `docs/compliance/`.

**Security basics.**
- Zod on every input and membership checks on every group route.
- Body-size limits; `secureHeaders`; rate limits on auth and AI.
- Images sniffed by magic bytes.
- Web session in an httpOnly cookie only.
- Android backups off.

**Design.**
- 16 themes (4 festive), all AA-contrast tested.
- Gabarito wordmark and the Plico mascot.
- Personal app theme; a group theme overrides it inside that group.
- `DESIGN.md` and `PRODUCT.md` hold the design and product rules.

## Sync

### Today

| Piece | How |
|---|---|
| Local data | Whole state as JSON in one `localStorage` key (`splittr`), saved on every edit |
| Outbox | `localStorage` key `splittr-outbox`: an ordered list of `{method, path, body}` |
| Making ops | Debounced diff of current state vs last synced snapshot → PUT/DELETE per changed group, member, expense. Order: profile, groups, members, expenses, then deletes in reverse |
| Sending | One op at a time, in order. Network error → stop, retry on `online`, on app focus, every 30 s. 5xx → keep and retry. 401 → signed out. Other 4xx → dropped, the next pull restores the server's version |
| Pulling | `GET /api/groups` returns every group in full. Skipped while ops are queued (local edits must land first); after a flush, the server copy replaces the local one |
| Server write | Each expense PUT is one transaction: upsert the expense, replace its shares. Idempotent: the same op twice gives the same row |
| IDs | UUIDs made on the phone; recurring copies use `<id>:<date>`, so two phones generating the same monthly copy write the same row |

**What's safe:**
- Concurrent *adds* never collide.
- Balances can't drift.
- A half-written expense can't exist.
- Retries don't duplicate.
- Each person's own profile can only be written by them.

**What isn't (the reason for Sync v2):**
- Edits to the *same* expense are last-write-wins with no warning.
- An offline edit resurrects an expense someone deleted.
- Refused changes are dropped silently.
- WebView storage can be evicted by the OS.
- Every pull is a full download.

### Sync v2 (planned, `PLAN.md`)
- A version number per expense, sent with every edit as `base`.
- The server refuses stale edits with **409** and returns the other version; the user picks *keep mine* / *keep theirs*.
- Soft deletes with **restore**.
- Delta pulls with tombstones.
- Coalesced outbox ops.
- Refused changes shown, not dropped.
- Outbox in native Preferences, group cache in IndexedDB.

### Why not SQLite, CRDTs or a sync engine
- **SQLite** on the phone (`@capacitor-community/sqlite`) adds a native dependency and a second schema to keep in step, and there's no web version without WASM. Our local data is small and read whole. IndexedDB + native Preferences gives durability without that. SQLite earns its place only if we need on-device queries over large history (search across years of expenses).
- **CRDTs / Automerge / Yjs** merge automatically. For money that's the wrong default: silently merging "₹1,200 split 3 ways" with "₹1,500 split 4 ways" produces an expense nobody entered. A visible conflict is better.
- **Sync engines** (PowerSync, ElectricSQL, Replicache, Firebase) would replace our outbox but tie the data layer to a vendor. The outbox is ~300 lines and already works the same way Splitwise's does.

## Compared with the market

### Splitwise, in detail
- **Stack.**
  - Ruby on Rails powers their APIs ([Splitwise job posting](https://jobs.insightpartners.com/companies/splitwise/jobs/46442808-software-engineer)).
  - The Android app is primarily Kotlin ([WayUp posting](https://www.wayup.com/i-j-Splitwise-602190854701488/)).
  - Separate native iOS and Android apps plus a web app: three UI codebases against our one.
- **Offline.**
  - Since 2014 the mobile apps keep "a log of all changes made" and push them "in the order they were committed", skipping what can't run yet and retrying in the background ([Splitwise blog, 2014](https://blog.splitwise.com/2014/06/13/coming-to-splitwise-for-android-offline-mode-multiple-payers/)). That's the same outbox model as ours.
  - Offline you can add and remove expenses in existing groups but not create friends or groups ([Splitwise feedback](https://feedback.splitwise.com/forums/162446-general/suggestions/9786933-improve-offline-mode-in-iphone-app)). Plico allows both offline, because IDs are made on the phone.
- **Conflicts.**
  - Their public API has `updated_at`, `updated_after` and `deleted_at`, but no ETag, version or conflict mechanism is documented ([dev.splitwise.com](https://dev.splitwise.com/)). Concurrent edits are effectively last-write-wins, like Plico today.
  - What they add on top is **transparency**: an edit history on each expense and an activity feed that says what changed ([App Store listing](https://apps.apple.com/us/app/splitwise/id458023433)).
- **Deletes:** soft deletes with **Undelete expense** from the activity feed ([Splitwise help](https://feedback.splitwise.com/knowledgebase/articles/298437-how-do-i-restore-un-delete-an-expense)). Plico hard-deletes today; Sync v2 adds soft delete + restore.
- **Retries:** `create_expense` isn't documented as idempotent, and a 200 can still carry errors ([dev.splitwise.com](https://dev.splitwise.com/)). Plico's PUT-by-client-ID is idempotent by design.
- **Balances:** returned by the server per friend and per group, with `original_debts`, `simplified_debts` and `simplify_by_default`, multi-currency. Plico derives balances from expenses on both client and server, INR only for now.
- **India and payments:**
  - No UPI integration; a Paytm-only "Pay with Paytm" flow on Android ([Splitwise feedback](https://feedback.splitwise.com/forums/162446-general/suggestions/15872739-is-it-possible-to-integrate-upi-unified-payment-s?category_id=57380&page=3&per_page=20), [Niptao comparison](https://niptao.app/en/blog/bill-splitting-apps-with-upi)).
  - Plico's settle-up is UPI-first (any UPI app, QR, the payee's name shown, payee confirms).
- **Price:**
  - The free tier caps new expenses at roughly 3–5 per day. Pro is about $4.99/month or $39.99–49.99/year in the US ([splitty](https://splittyapp.com/learn/splitwise-free-limits/), [Are We Even](https://www.areweeven.com/blog/splitwise-free-vs-pro-2026)).
  - Receipt scanning, charts and currency conversion are Pro-only.

### The field

| | **Plico** | **Splitwise** | **Tricount** (bunq) | **Settle Up** | **Splid** |
|---|---|---|---|---|---|
| Client tech | One React codebase → PWA + Android + iOS (Capacitor) | Native Kotlin + native iOS + web | Native apps + web | Native apps + web | Native apps, no web |
| Backend | Hono + Postgres (Supabase, Mumbai) | Ruby on Rails | Proprietary | Firebase Realtime Database ([api.settleup.io](https://api.settleup.io/)) | Proprietary |
| Offline | Everything, including new groups and people | Add/remove expenses in existing groups | Yes | Yes (Firebase offline cache) | Yes, a headline feature |
| Same-record conflicts | Last write wins (v2: 409 + "keep mine / theirs") | Last write wins + edit history | Not documented | Firebase last write wins per field | Not documented |
| Deleted expenses | Hard delete (v2: soft + restore) | Soft delete + undelete | Not documented | Not documented | Not documented |
| Account needed | Yes (free) | Yes | Yes | Yes | No |
| UPI settle-up | Native: intent link, QR, payee confirms | Paytm-only (Android) | No | No | No |
| Receipt / screenshot capture | AI, free, opt-in, with line items | Pro only | No | No | No |
| Free tier | Unlimited | ~3–5 expenses/day | Free | Free with ads; premium per trip | Free; small one-off unlock |
| Source | Open source (planned) | Closed | Closed | Closed | Closed |

Sources: [Hippo Split comparison](https://hipposplit.com/blog/splitwise-vs-tricount-vs-settle-up/), [Spliit: Tricount vs Splid](https://spliit.pro/blog/tricount-vs-splid/), [Tricount features](https://tricount.com/expense-tracker-features), plus the Splitwise links above. Rows marked "not documented" are closed apps whose sync internals aren't public; we haven't guessed.

### Where Plico stands

**Ahead:**
- Unlimited and free.
- UPI-native settle-up with payee confirmation.
- AI capture from photos, screenshots and share sheets.
- Idempotent writes.
- Offline creation of groups and people.
- India data residency and DPDP compliance (parental consent, AI opt-in).
- One codebase, so features ship to all platforms at once.
- Open source.

**Behind (and the plan):**

| Where Splitwise is ahead | Our plan |
|---|---|
| Edit history and activity feed, undelete | Sync v2 (undelete), then the activity log |
| Push notifications | Server push after Sync v2 |
| Multi-currency | Not planned yet: INR-first by product choice |
| 14 years of scale and polish | — |
| Native feel on both platforms | Capacitor is close but not native; the widgets and share extension are native |

**Worth borrowing from Splitwise:** the activity feed as the trust layer. When money changes, people want to see who changed it and from what. Even with 409 conflicts, an edit history is what stops arguments.

## Scale ceilings we know about

| Ceiling | Upgrade path |
|---|---|
| `localStorage` ~5 MB for all groups | IndexedDB (Sync v2 step 7) |
| Full pull every 30 s | Delta pulls (Sync v2 step 3), then server push |
| AI rate limit is in-memory per server process (40/hour/user) | Move it to Postgres or Redis when the server runs more than one instance (Vercel does) |
| No per-user write rate limits on uploads, members or expenses | Add alongside the AI limiter |
| Native auth token in app preferences, not Keychain/Keystore | Secure-storage plugin |
| Supabase Storage reached through our API (extra hop for photos) | CDN in front of the public avatars bucket |
