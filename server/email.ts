// Transactional email. ZeptoMail first, Resend as fallback, console when neither is configured (dev).
// Every provider is plain fetch: no SDKs, and switching is a matter of env vars.
const FROM = process.env.EMAIL_FROM || 'Splittr <no-reply@splittr.example>' // placeholder until a domain is verified
const APP = process.env.PUBLIC_URL || 'http://localhost:5173'

type Mail = { to: string; subject: string; html: string; text: string }

const parseFrom = (f: string) => {
  const m = f.match(/^(.*)<(.+)>$/)
  return m ? { name: m[1].trim(), address: m[2].trim() } : { name: 'Splittr', address: f.trim() }
}

async function zeptomail(m: Mail) {
  const token = process.env.ZEPTOMAIL_TOKEN
  if (!token) return false
  const res = await fetch(process.env.ZEPTOMAIL_URL || 'https://api.zeptomail.in/v1.1/email', {
    method: 'POST',
    headers: { Authorization: token.startsWith('Zoho-enczapikey') ? token : `Zoho-enczapikey ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ from: parseFrom(FROM), to: [{ email_address: { address: m.to } }], subject: m.subject, htmlbody: m.html, textbody: m.text }),
  })
  if (!res.ok) throw new Error(`ZeptoMail ${res.status}: ${await res.text()}`)
  return true
}

async function resend(m: Mail) {
  const key = process.env.RESEND_API_KEY
  if (!key) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
  return true
}

export async function sendEmail(m: Mail) {
  for (const provider of [zeptomail, resend]) {
    try {
      if (await provider(m)) return
    } catch (e) {
      console.error('[email] provider failed, trying the next one:', (e as Error).message)
    }
  }
  if (process.env.ZEPTOMAIL_TOKEN || process.env.RESEND_API_KEY) throw new Error('All email providers failed')
  console.log(`\n[email:dev] to ${m.to}\n  ${m.subject}\n  ${m.text.replace(/\n/g, '\n  ')}\n`)
}

// ---------- templates: one brand layout, plain-text twin for every mail ----------
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function layout(title: string, body: string, cta: { label: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#F7F7FB;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#17171C">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:16px;padding:32px">
<tr><td style="font-weight:700;font-size:20px;color:#6C5CE7;padding-bottom:24px">Splittr</td></tr>
<tr><td style="font-size:22px;font-weight:700;line-height:1.25;padding-bottom:12px">${esc(title)}</td></tr>
<tr><td style="font-size:16px;line-height:1.55;color:#3a3a44;padding-bottom:24px">${body}</td></tr>
<tr><td><a href="${esc(cta.url)}" style="display:inline-block;background:#6C5CE7;color:#FFFFFF;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:12px">${esc(cta.label)}</a></td></tr>
<tr><td style="font-size:13px;color:#5E5E6A;padding-top:24px">If the button doesn’t work, open this link:<br><a href="${esc(cta.url)}" style="color:#5145CD;word-break:break-all">${esc(cta.url)}</a></td></tr>
</table></td></tr></table></body></html>`
}

export const mail = {
  verify: (to: string, name: string, url: string) => sendEmail({
    to, subject: 'Verify your email for Splittr',
    html: layout(`Hi ${name}, confirm it’s you`, 'Verify your email so any group a friend has added you to shows up in your Splittr.', { label: 'Verify email', url }),
    text: `Hi ${name},\n\nVerify your email so any group a friend has added you to shows up in your Splittr:\n${url}`,
  }),
  reset: (to: string, url: string) => sendEmail({
    to, subject: 'Reset your Splittr password',
    html: layout('Reset your password', 'Someone asked to reset your Splittr password. If that was you, choose a new one below. If not, you can ignore this email.', { label: 'Choose a new password', url }),
    text: `Reset your Splittr password:\n${url}\n\nIf you didn’t ask for this, ignore this email.`,
  }),
  invite: (to: string, inviter: string, group: string, url: string) => sendEmail({
    to, subject: `${inviter} added you to “${group}” on Splittr`,
    html: layout(`${inviter} added you to ${group}`, `${esc(inviter)} is splitting expenses for <strong>${esc(group)}</strong> on Splittr. Join to see what you owe or are owed, and settle up over UPI.`, { label: 'See the group', url }),
    text: `${inviter} added you to “${group}” on Splittr.\n\nJoin to see what you owe or are owed:\n${url}`,
  }),
  added: (to: string, inviter: string, group: string) => sendEmail({
    to, subject: `${inviter} added you to “${group}”`,
    html: layout(`You’re in ${group}`, `${esc(inviter)} added you to <strong>${esc(group)}</strong>. It’s already in your Splittr.`, { label: 'Open Splittr', url: `${APP}/#/` }),
    text: `${inviter} added you to “${group}”. It’s already in your Splittr: ${APP}/#/`,
  }),
  emailChanged: (to: string, newEmail: string, url: string) => sendEmail({
    to, subject: 'Confirm your new Splittr email',
    html: layout('Confirm the email change', `Your Splittr account is changing its email to <strong>${esc(newEmail)}</strong>. If that’s you, confirm below. If not, change your password now.`, { label: 'Confirm change', url }),
    text: `Your Splittr email is changing to ${newEmail}. Confirm: ${url}\nIf this wasn’t you, change your password now.`,
  }),
  deleteAccount: (to: string, url: string) => sendEmail({
    to, subject: 'Confirm deleting your Splittr account',
    html: layout('Delete your account?', 'This removes your account and signs you out everywhere. Groups you’re in stay for the others, with you as a guest. This can’t be undone.', { label: 'Delete my account', url }),
    text: `Confirm deleting your Splittr account: ${url}\nGroups stay for the others, with you as a guest. This can’t be undone.`,
  }),
}
