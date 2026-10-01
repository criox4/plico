// Does a payer's UPI receipt prove the settlement it's attached to? The pure part, so server/proof.test.ts runs it directly.
export type ReceiptRead = { amount: number | null; utr: string | null; payee: string | null; at: string | null; status: string | null }
export type Settlement = { amount: number; createdAt: Date; payee: { name: string; upi?: string | null; upi2?: string | null } }

export const NO_READ: ReceiptRead = { amount: null, utr: null, payee: null, at: null, status: null }
const WINDOW = 3 * 864e5 // receipt time within 3 days either side of when the settlement was recorded
const words = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)

/** The payee as the receipt shows them: one of their UPI IDs (any case), or their first name at the start of a word. */
function payeeMatches(shown: string | null, p: Settlement['payee']) {
  if (!shown) return false
  const s = shown.toLowerCase()
  if ([p.upi, p.upi2].some(u => u && s.includes(u.trim().toLowerCase()))) return true
  // ponytail: loose on purpose (banks print "ASHA R SHARMA", "Asha S"); the amount, time and transaction ID carry the weight.
  const first = words(p.name)[0]
  return !!first && first.length >= 3 && words(shown).some(w => w.startsWith(first))
}

/** A status that reads as done, not failed, pending or reversed. */
export const succeeded = (status: string | null) =>
  !!status && /success|completed|paid|sent|credited|done/i.test(status) && !/unsuccess|fail|pending|processing|declin|revers|refund|cancel/i.test(status)

/** Each check on the receipt, and whether together they verify the settlement. usedElsewhere: its transaction ID already proved another one. */
export function checkReceipt(read: ReceiptRead, s: Settlement, usedElsewhere: boolean) {
  const at = read.at ? Date.parse(read.at) : NaN
  const checks = {
    amount: read.amount === s.amount,
    payee: payeeMatches(read.payee, s.payee),
    time: !isNaN(at) && Math.abs(at - s.createdAt.getTime()) <= WINDOW,
    fresh: !usedElsewhere,
  }
  return { checks, verified: Object.values(checks).every(Boolean) && succeeded(read.status) }
}
