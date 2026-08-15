import { createHmac, timingSafeEqual } from 'node:crypto'

const TOLERANCE_MS = 5 * 60 * 1000

/**
 * Vérifie la signature des webhooks sortants Mesgia.
 * Schéma : HMAC-SHA256(secret, "${timestamp}.${body}") hex, fenêtre ±5 min.
 * @param {{ signatureHeader?: string, timestampHeader?: string, body: string, secret: string, now?: number }} args
 * @returns {{ ok: boolean, error?: string }}
 */
export function verifyMesgiaSignature({ signatureHeader, timestampHeader, body, secret, now = Date.now() }) {
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, error: 'headers X-Mesgia-Signature/Timestamp manquants' }
  }
  const ts = parseInt(timestampHeader, 10)
  if (Number.isNaN(ts) || Math.abs(now - ts * 1000) > TOLERANCE_MS) {
    return { ok: false, error: 'timestamp expiré ou invalide' }
  }
  const provided = signatureHeader.replace(/^sha256=/i, '')
  const expected = createHmac('sha256', secret).update(`${timestampHeader}.${body}`).digest('hex')
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'signature invalide' }
  }
  return { ok: true }
}
