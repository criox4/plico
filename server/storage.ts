// File storage on Supabase Storage via its REST API (no SDK). Phones never reach Supabase directly:
// Indian ISPs sinkhole *.supabase.co, so every file goes through our API.
import https from 'node:https'
import type { LookupFunction } from 'node:net'

const BASE = process.env.SUPABASE_URL ?? ''
const KEY = process.env.SUPABASE_SECRET_KEY ?? ''
// Dev on a network that sinkholes supabase.co: pin the host to its real IP (look it up over DNS-over-HTTPS).
const IP = process.env.STORAGE_IP
export const BUCKET = { public: process.env.S3_BUCKET_PUBLIC || 'avatars', private: process.env.S3_BUCKET_PRIVATE || 'uploads' }
export const storageReady = () => !!(BASE && KEY)

type Res = { status: number; type: string; body: Buffer }
function call(method: string, path: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = https.request(BASE + '/storage/v1' + path, {
      method,
      headers: { authorization: `Bearer ${KEY}`, apikey: KEY, ...headers },
      ...(IP && { lookup: ((_h: string, o: { all?: boolean }, cb: Function) => (o.all ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4))) as unknown as LookupFunction }),
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    r.setTimeout(20000, () => r.destroy(new Error('Storage timed out')))
    if (body) r.write(body)
    r.end()
  })
}
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')

export async function putFile(bucket: string, path: string, data: Buffer, type: string) {
  const r = await call('POST', `/object/${bucket}/${enc(path)}`, data, { 'content-type': type, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' })
  if (r.status >= 300) throw new Error(`Storage upload ${r.status}: ${r.body.toString().slice(0, 200)}`)
}

export async function getFile(bucket: string, path: string) {
  const r = await call('GET', `/object/authenticated/${bucket}/${enc(path)}`)
  return r.status === 200 ? r : null
}

export async function deleteFile(bucket: string, path: string) {
  await call('DELETE', `/object/${bucket}`, JSON.stringify({ prefixes: [path] }), { 'content-type': 'application/json' }).catch(() => {})
}

/** Only real images, sniffed from their first bytes (never trust the declared type). */
export function imageType(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}
