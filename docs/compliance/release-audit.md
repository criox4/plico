# Plico release audit (2026-09-27)

Scope: web app/PWA, API (Hono + Better Auth + Prisma on Supabase), Android and iOS (Capacitor 8).
Method: indie-apple-stack `release-review` (security, privacy, UX, distribution checklists), `security/privacy-manifests`, `legal/privacy-policy`; Capgo `capacitor-security` rule set (SEC/STO/NET/CAP/AND/IOS/AUTH), checked by hand because its `capsec` CLI isn't published on npm; plus India DPDP Act 2023 + DPDP Rules 2025, IT Rules 2021, App Store Review Guidelines and Google Play policies.

## Summary

| Priority | Found | Fixed | Open |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 4 | 4 | 0 |
| Medium | 7 | 6 | 1 |
| Low | 5 | 2 | 3 |

## Findings

| # | Priority | Finding | Status |
|---|---|---|---|
| 1 | High | Any group member could change a *joined* member's UPI ID, email or phone, redirecting that person's incoming payments. | Fixed `16be08f`: only the person can change their own details; server ignores others' edits. |
| 2 | High | App Store 4.8: Google sign-in offered on iOS without Sign in with Apple. | Fixed `06f6f11`, then `1b94f44`: Sign in with Apple added on iOS (shown first) and Google brought back. |
| 3 | High | DPDP Act s.9: no age check; minors' data processed without a parent's consent. | Fixed `e3a4a14`: age at sign-up (13+), parent consent by email for 13–17, API blocks until consent, decline deletes the account. |
| 4 | High | App Store 5.1.2(i) / DPDP: photos and sentences sent to a third-party AI without explicit consent. | Fixed `e3a4a14`: one-time consent before the first AI read, switch in Privacy and data; OpenRouter `data_collection: deny`. |
| 5 | Medium | No privacy manifest (App, ShareExtension, PlicoWidget use UserDefaults and an App Group). | Fixed `06f6f11`: `PrivacyInfo.xcprivacy` × 3 (CA92.1, 1C8F.1; no tracking). |
| 6 | Medium | WebView file picker can open the camera; no `NSCameraUsageDescription` (crash on iOS). | Fixed `06f6f11`. |
| 7 | Medium | Uploads read fully into memory before the size check; no global body limit. | Fixed `16be08f`: 256 KB JSON, 3/6/7 MB image limits enforced before reading. |
| 8 | Medium | No security headers (nosniff, frame options, HSTS, referrer policy). | Fixed `16be08f`: `secureHeaders` on every response. |
| 9 | Medium | Web bearer token in localStorage (XSS exposure). | Fixed `16be08f`: web uses the httpOnly cookie only. |
| 10 | Medium | No privacy policy, terms, account-deletion web page, data export. | Fixed `7b2a5b7`, `e3a4a14`. |
| 11 | Medium | Native bearer token lives in WebView localStorage, not Keychain/Keystore (STO006). | **Open.** Move to a secure-storage plugin before scale. |
| 12 | Low | Android `allowBackup=true` (tokens and ledger in cloud backups). | Fixed `16be08f`. |
| 13 | Low | Auth rate limiting relied on defaults and couldn't see client IPs behind a proxy. | Fixed: explicit limit + `x-vercel-forwarded-for`. |
| 14 | Low | Upload, member and expense routes have no per-user rate limit (only AI reads do). | **Open.** Add when abuse appears (per-process limiter exists in `/ai/read`). |
| 15 | Low | No root/jailbreak detection (CAP007/IOS007). | **Won't fix**: no money moves through Plico; low value. |
| 16 | Low | Screenshots of pay screens not blocked (IOS008). | **Won't fix**: people screenshot pay QR codes on purpose. |

Also checked and clean: no secrets in git history (41 commits scanned for Supabase, Resend, OpenRouter, Google and DB patterns; `.env*` ignored); no `eval`, `new Function` or raw HTML; Zod validation on every API input; group membership checked on every group route; claim and consent tokens are 128–256-bit random; images sniffed by magic bytes; HTTPS-only (no cleartext config); CORS limited to known origins; no tracking SDKs; no debug logging in the client; Android only requests INTERNET; exported components limited to the launcher activity.

## Before you publish (needs you)

1. ~~Postal address~~ Done: Bengaluru, Karnataka in the Privacy Policy and Terms; courts at Bengaluru for disputes.
2. **Create `privacy@plico.space`** at Hostinger (or a forward). Every legal page and email points to it.
3. **Pick an open-source licence** (MIT, Apache-2.0 or AGPL-3.0) and add `LICENSE`; the Terms reference it. Once the repo is pushed, link it from the Privacy Policy (section 1) and Terms (licence section); the links were removed until it exists.
4. **Parental consent strength:** email + a declaration meets the basic bar; DPDP Rules 2025 (Rule 10) expect "verifiable" consent, e.g. checking the parent's identity/age against records or a DigiLocker token. Consider adding DigiLocker before marketing to teens, and get a lawyer's read.
5. **Sign in with Apple, Apple side:** in the Apple Developer account enable the *Sign in with Apple* capability on the `app.plico` App ID (the entitlement is already in `App.entitlements`). To email users who hide their address, register `plico.space` and the sending address under *Services → Sign in with Apple for Email Communication*, or mail to `@privaterelay.appleid.com` bounces.
9. **Apple token revocation on account deletion (guideline 5.1.1(v)):** Apple asks apps using Sign in with Apple to revoke the user's Apple tokens when they delete their account. That needs a Sign in with Apple key (.p8, Key ID, Team ID) to exchange the sign-in code and call Apple's revoke endpoint. Not built yet; deleting the account already removes all Plico data, and users can also remove Plico under Settings → Apple ID → Sign in with Apple. Add it when you create the key, or if review asks.
6. **Rotate keys** that were pasted in chat (Supabase password, service_role and secret keys, storage keys, Resend and OpenRouter keys).
7. **Store forms:** fill them from `store-privacy.md`.
8. **iOS in Xcode:** set the team for App, ShareExtension and PlicoWidget; enable the `group.app.plico` App Group; confirm the three privacy manifests are in each target's resources.
