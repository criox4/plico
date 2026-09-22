// Reads an expense out of a sentence, a receipt photo or a payment screenshot, via OpenRouter.
// Structured output only: the model fills a JSON schema; we never execute or render what it says as markup.
const KEY = process.env.OPENROUTER_API_KEY
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-6-luna'
export const aiReady = () => !!KEY

const CATS = ['food', 'groceries', 'stay', 'transport', 'drinks', 'fun', 'rent', 'bills', 'help', 'other']
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'amount', 'cat', 'date', 'payer', 'people', 'items', 'extras'],
  properties: {
    title: { type: 'string', description: 'Short label, e.g. "Dinner at Toit", "Swiggy order", "Uber to airport"' },
    amount: { type: ['number', 'null'], description: 'Grand total actually paid, in rupees' },
    cat: { type: 'string', enum: CATS },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD if stated or printed, else null' },
    payer: { type: ['string', 'null'], description: 'Who paid: "me" or a name from the member list, else null' },
    people: { type: 'array', items: { type: 'string' }, description: 'Who shares it: "me" and/or names from the member list. Empty = everyone' },
    items: {
      type: 'array', description: 'Line items on a bill (price × quantity already applied). Empty for a sentence or a plain payment',
      items: { type: 'object', additionalProperties: false, required: ['name', 'amount'], properties: { name: { type: 'string' }, amount: { type: 'number' } } },
    },
    extras: { type: 'number', description: 'Taxes, GST, service charge, delivery, packaging and tip minus discounts, in rupees, so that items + extras = amount' },
  },
}
const SYSTEM = `You turn one shared expense into JSON for an Indian bill-splitting app. Amounts are in rupees (₹), Indian number formatting (1,00,000 = one lakh).
From a receipt or food-delivery order: list every line item with its final price, put taxes, GST, CGST/SGST, service charge, delivery, packaging, platform fee and tip minus any discount into "extras", and set "amount" to the grand total paid.
From a UPI or bank payment screenshot (GPay, PhonePe, Paytm): amount = the amount paid, title = the payee or merchant, no items.
From a sentence: follow what it says about who paid and who is in. Only use "me" or names from the member list for payer and people.
Never invent amounts that are not shown or said. If there is no amount, use null.`

import type { Read } from '../src/schema.ts'
export type { Read }

export async function readExpense(input: { text?: string; image?: string; members: string[]; today: string }): Promise<Read> {
  const user: unknown[] = [{ type: 'text', text: `Today is ${input.today}. Members: me${input.members.length ? ', ' + input.members.join(', ') : ''}.${input.text ? `\nThe expense: ${input.text}` : '\nRead the expense in this image.'}` }]
  if (input.image) user.push({ type: 'image_url', image_url: { url: input.image } })
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': process.env.PUBLIC_URL || 'https://plico.space', 'X-Title': 'Plico' },
    body: JSON.stringify({
      model: MODEL, temperature: 0,
      // Only route to providers that don't store or train on prompts.
      provider: { data_collection: 'deny' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'expense', strict: true, schema: SCHEMA } },
    }),
    signal: AbortSignal.timeout(45000),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  const out = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as Read
  // Trust nothing: clamp to what the app can store.
  const money = (n: unknown) => (typeof n === 'number' && isFinite(n) && n > -1e8 && n < 1e8 ? Math.round(n * 100) / 100 : null)
  return {
    title: String(out.title ?? '').slice(0, 80), amount: money(out.amount), cat: CATS.includes(out.cat) ? out.cat : 'other',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(out.date)) ? out.date : null, payer: out.payer ? String(out.payer).slice(0, 60) : null,
    people: (Array.isArray(out.people) ? out.people : []).slice(0, 50).map(p => String(p).slice(0, 60)),
    items: (Array.isArray(out.items) ? out.items : []).slice(0, 60).map(i => ({ name: String(i?.name ?? 'Item').slice(0, 60), amount: money(i?.amount) ?? 0 })),
    extras: money(out.extras) ?? 0,
  }
}
