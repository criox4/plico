# Plico: user flow, navigation and APIs

Status 2026-09-27. Diagrams (Koboyo, editable, live embeds):

- **Current flow:** <https://koboyo.com/e/018e369e-3405-4e9c-abff-1f2f054de4fd/8b4ac8f6-8a4a-43db-b60d-029e0c74d3dc.svg>
- **Proposed flow:** <https://koboyo.com/e/018e369e-3405-4e9c-abff-1f2f054de4fd/7b6601d2-5681-4e33-bc5f-95d1009449c6.svg>
- Board: <https://koboyo.com/edit/plico-current-user-flow-2026-09-27-q18zs6>

## 1. The flow today

### Getting in
1. `plico.space` → splash → **no session:** the welcome screen (a phone-width column, even on desktop).
   - Google or Apple (iPhone only) or email.
2. Sign up asks your age. Google and Apple accounts get the **age gate** once.
   - 13–17 → **waiting for a parent** until the emailed consent is given.
   - Under 13 can't join.
3. **No groups yet** → *Who's spending together?* (new group, or import from Splitwise). Otherwise → **Home**.

### Links that arrive from outside
| Link | Where it goes | Needs an account |
|---|---|---|
| `#/join/<code>` group invite | sign in, then *Join as you* | yes, and nothing about the group is shown before sign-in |
| `#/claim/<token>` personal invite | sign in, then *Join as <name>* | yes, same |
| `#/s/<payload>` pay link | public pay page: payee, UPI, QR | no |
| `#/guardian/<token>` | parent's consent page | no |
| `#/reset`, `#/verified`, `#/delete/<token>` | password reset, email verified, delete confirm | mixed |

### Moving around (signed in)
A bottom dock on every screen width: **Home · Friends · + · Log · You**.
- **Home:** total balance, *Needs you* cards, group slips, 6 recent expenses.
- **Group:** balance, settle list with Settle/Remind, spend bar, expenses.
  - Group **settings:** name, type, theme, people, invite link, delete.
  - **Audit log.**
  - **Expense** (edit) → **History**.
  - **Settle up** → UPI / QR / cash.
- **Friends:** balance with everyone, a friend's page, settle across groups, add friend.
- **Log:** changes to *your* balance across groups.
- **You:** profile, appearance, reminders, privacy and data, sign-in and security, devices, delete account.
- **+:** add expense (pick a group). Sharing a screenshot into Plico opens the same form.

### What's missing
1. **No front door.** A web visitor lands on the sign-up screen. Nothing says what Plico is, shows it working, or answers "is my money safe here?".
2. **No navigation on desktop or tablet.** The app is a 560px column in the middle of a wide screen. The dock stretches edge to edge with its items spread out, and there's no sidebar, group list or account menu.
3. **Invites are blind.** An invite link asks you to sign up before telling you who invited you or to which group. That's the moment most invited people drop off.
4. **No "what happened while I was away".** The Log shows only changes to your own balance. There's no feed of what others did in your groups, and no unread badge.
5. **No search** across groups, friends and expenses.
6. **No way to leave a group.** Only the creator can delete it.
7. **Friends:** the add-friend form sits permanently at the bottom of the list.
8. **Home:** no view of people; money shows paise (₹61,341.66) where rupees are enough at a glance; the recent list competes with groups.

## 2. The flow proposed

### Getting in
- **Web, signed out → Landing page** at `/`: what Plico is, the product shown working (real app screens in several themes), trust (UPI to a name you can see, the verified audit log, offline, India data residency, DPDP), and *Get started* / *Sign in*.
  - Also: a Splitwise import note, and an apps-coming-soon note.
  - Footer: privacy, terms, cookies, delete account.
- **Phone apps, signed out → Welcome** (as now; stores don't need a marketing page).
- **Invite links → Invite preview** before sign-in: *Asha invited you to Goa '26 · 4 people*.
  - A personal invite pre-fills the sign-up email.
  - After sign-in you land in the group.

### Navigation that fits the screen
| Width | Pattern |
|---|---|
| < 900px (phones) | Bottom tabs: **Home · Friends · + · Activity · You** |
| ≥ 900px (tablet, desktop) | **Left sidebar**, with content in a 720px column:<ul><li>wordmark</li><li>**Add expense**</li><li>Home, Friends, Activity</li><li>a **Groups** list with each balance, plus *New group*</li><li>You (avatar, name) at the bottom</li></ul> |

- **Top bar:** screen title, back on inner screens, and **search** (`/` on desktop) over groups, friends and expenses.
- **Activity** replaces Log: *Everything* (all changes in your groups, with an unread badge) or *My money* (today's Log).
- **Home:**
  - the total balance in rupees;
  - *Needs you*;
  - **People** (the friends you settle with most, with balances) → Friends;
  - Groups;
  - Recent.
- **Friends:** search, filter (*owes you / you owe / all*), and *Add friend* as a button that opens the form, not a permanent block.
- **Group:** *Leave group* (when you're settled) in group settings.

## 3. Screens and the API behind each

Plico is offline-first: screens read the phone's copy of your groups (`src/store.ts`), which one sync call keeps fresh. Only the screens marked **online** call an API directly.

| Screen | Data | API |
|---|---|---|
| Landing | static, plus sign-in options | `GET /api/config` |
| Welcome, sign up/in, reset, verify | Better Auth | `/api/auth/*` (email, Google, Apple, reset, verify) |
| Age gate, parent wait | account | `POST /api/me/age`, `POST /api/me/guardian`; parent: `GET/POST /api/guardian/:token` (public) |
| **Invite preview** (new) | group, inviter | **`GET /api/public/invites/:code`**, **`GET /api/public/claim/:token`** (new, public) |
| Join / claim | | `POST /api/invites/:code/join`, `POST /api/claim/:token` |
| Home, Group, Friends, Friend | local | sync: `GET /api/groups?since&known`, the outbox's PUT/DELETE |
| Add/edit expense | local, then outbox | `PUT/DELETE /api/groups/:gid/expenses/:eid` (versioned), `POST …/restore` |
| Capture (scan, type it) | online | `POST /api/ai/read`, `POST /api/groups/:gid/files` |
| Group settings, people | local, then outbox | `PUT /api/groups/:id`, `PUT/DELETE /api/groups/:gid/members/:mid`, `POST …/invite`, `GET /api/groups/:id/invite` |
| **Leave group** (new) | online | **`POST /api/groups/:gid/leave`** |
| Add friend | online | `POST /api/friends` |
| Audit log, expense history | online | `GET /api/groups/:gid/audit`, `GET …/expenses/:eid/history` |
| **Activity** (new, replaces Log) | online | **`GET /api/me/activity`**, **`POST /api/me/activity/seen`** |
| Search | local | none (searches the phone's copy) |
| You, account pages | account | `/api/auth/update-user`, `change-email`, `change-password`, `list-sessions`, `revoke-session`, `link-social`, `unlink-account`, `delete-user`; `POST /api/me/avatar`, `POST /api/me/ai`, `GET /api/me/export` |
| Public pay page | in the link | none |
| Photos | | `GET /api/groups/:gid/files/:name`, `GET /api/files/avatars/:uid/:name` (public) |

## 4. New APIs

### `GET /api/public/invites/:code` (no sign-in)
What a group invite link shows before anyone signs up.
```json
{ "group": { "name": "Goa '26", "kind": "trip", "theme": "goa", "people": 4 },
  "invitedBy": "Asha" }
```
- `404` for a wrong code and for friends (direct) groups.
- No member names, emails or amounts: a leaked link must not leak the group.
- Rate-limited per IP.

### `GET /api/public/claim/:token` (no sign-in)
A personal invite's preview, and the email to pre-fill.
```json
{ "group": { "name": "Flat 404", "kind": "home", "theme": "matcha" }, "invitedBy": "Asha", "name": "Riya", "email": "ri***@gmail.com", "prefill": "riya@gmail.com" }
```
- `prefill` is only returned for the token that was emailed to that address. The token is 128-bit and single-use, and is retired when the email changes.
- `404` once it's been claimed (claiming clears the token).

### `GET /api/me/activity?scope=all|money&before=<ISO>` (signed in)
The Activity tab: audit entries across all your groups, newest first, 50 per page.
```json
{ "events": [{ "groupId": "…", "group": { "name": "Goa '26", "kind": "trip" }, "seq": 42, "kind": "expense.edited",
               "byName": "Bala", "byMe": false, "at": "…", "before": {…}, "after": {…}, "effect": {"<memberId>": -40000},
               "myEffect": -40000 }],
  "unread": 3, "next": "<ISO or null>" }
```
- `scope=money` keeps only entries that moved your balance; this replaces `GET /api/me/audit`, which stays as an alias.
- `unread` counts entries by other people newer than your `activitySeenAt`.

### `POST /api/me/activity/seen { "at": "<ISO>" }`
- Sets `user.activitySeenAt` (new column); it never moves backwards. Clears the badge on every device.

### `POST /api/groups/:gid/leave`
- Leaves a group you're settled in: `409` with your balance if you aren't.
- Your spot becomes an email placeholder again, so history and totals stay intact; the audit log records `member.left`.
- The creator can leave only if someone else is in the group; the creator role passes to the longest-standing member.
- Friends (direct) groups can't be left.

### Considered and left out
- **A server-side home/summary endpoint:** Home is computed on the phone from synced data. It works offline and is always consistent with the ledger.
- **Server search:** the phone already holds everything you can see. Revisit if groups grow past what fits on a phone.
- **App-launch waitlist** (`POST /api/public/notify`): only if you want to collect emails before the store launch. It needs a consent line and a table.

## 5. Build order (one commit each) — shipped 2026-09-27: `8621068`, `60cedfd`, `8dc8ae5`, `88470f6`, `65cb7a1`, `48556d2`, `00e3c85`
1. **APIs:** public invite and claim previews, activity and seen (with `activitySeenAt`), and leave group. Covered by `scripts/sync-race.mts`.
2. **Navigation shell:** bottom tabs on phones and a sidebar with groups on desktop, the top bar with search, and Activity replacing Log.
3. **Invite preview screens:** before sign-in, with the email pre-filled.
4. **Home and Friends refinements.**
5. **Landing page:** its layout is chosen from three concepts first.
6. **Docs:** DESIGN.md (navigation, landing) and this file.
