# Store privacy answers

Policy URLs (after deploy): Privacy https://plico.space/privacy/ · Terms https://plico.space/terms/ · Account deletion https://plico.space/delete-account/ · Support: privacy@plico.space

## Apple: App Store Connect → App Privacy

**Do you or your third-party partners collect data?** Yes. **Tracking:** No (no ATT prompt needed).

| Data type | Collected | Linked to user | Tracking | Purpose |
|---|---|---|---|---|
| Contact Info → Name | Yes | Yes | No | App Functionality |
| Contact Info → Email Address | Yes | Yes | No | App Functionality |
| Contact Info → Phone Number | Yes (optional) | Yes | No | App Functionality |
| Financial Info → Other Financial Info (expenses, UPI ID) | Yes | Yes | No | App Functionality |
| User Content → Photos or Videos (receipts, avatars, covers) | Yes | Yes | No | App Functionality |
| User Content → Other User Content (expense titles, group names) | Yes | Yes | No | App Functionality |
| Identifiers → User ID | Yes | Yes | No | App Functionality |

Not collected: location, contacts, health, browsing/search history, purchases, usage data, diagnostics, device ID, sensitive info. Matches `ios/App/App/PrivacyInfo.xcprivacy`.

Other App Store answers: age rating 12+ (no objectionable content; user-generated content between known people); not a payments app (UPI hand-off only, guideline 3.1 doesn't apply; no in-app purchases); account deletion in-app (5.1.1(v)); export compliance: uses standard HTTPS only (exempt).

## Google Play: App content → Data safety

- **Does your app collect or share user data?** Yes, collects. **Shares?** No (processors acting for us aren't "sharing").
- **Encrypted in transit?** Yes. **Users can request deletion?** Yes (in-app + https://plico.space/delete-account/).

| Category → type | Collected | Optional? | Purpose |
|---|---|---|---|
| Personal info → Name | Yes | Required | App functionality, Account management |
| Personal info → Email address | Yes | Required | App functionality, Account management |
| Personal info → Phone number | Yes | Optional | App functionality |
| Personal info → User IDs | Yes | Required | Account management |
| Financial info → Other financial info (expenses, UPI ID) | Yes | Required | App functionality |
| Photos and videos → Photos | Yes | Optional | App functionality |
| App activity → Other user-generated content | Yes | Required | App functionality |

Not collected: location, contacts, messages, audio, files, calendar, health, app activity/analytics, web browsing, device IDs, crash logs.

Other Play answers: Target audience 13+ (not designed for children; no Families program); Ads: No; Financial features: none of the listed regulated services (no payments, loans, crypto, UPI processing); Government app: No; Account deletion URL above.

## Keep in sync

If you add analytics, crash reporting, ads, new SDKs or new data, update: the Privacy Policy, both tables above, `PrivacyInfo.xcprivacy`, and `public/privacy/index.html`.
