import { createHash } from 'node:crypto'
import { signEIP191, recoverAddress } from './wallet.mjs'

export const MAX_MESSAGE_CHARS = 5000
export const FETCH_TIMEOUT_MS = 10_000

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** true si l'erreur vient d'un AbortSignal.timeout / AbortController. */
function isTimeout(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError'
}

/**
 * Dérive l'adresse Ethereum (0x…, minuscule) d'une clé privée hexadécimale.
 * Utilise le round-trip signEIP191 + recoverAddress pour ne pas dupliquer la
 * logique d'adresse de wallet.mjs (signature sur un message de sonde dédié).
 */
export function deriveAddress(privateKey) {
  const probe = 'mesgia-relay:derive-address'
  return recoverAddress(probe, signEIP191(probe, privateKey))
}

async function fetchChallenge(base, wallet) {
  const res = await fetch(`${base}/api/cbor-web/challenge`, {
    headers: { 'X-CBOR-Web-Wallet': wallet },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    return { ok: false, error: `challenge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, status: res.status }
  }
  const body = await res.json()
  if (!body.challenge || typeof body.challenge !== 'string') {
    return { ok: false, error: 'Réponse challenge invalide (champ challenge manquant)' }
  }
  return { ok: true, challenge: body.challenge }
}

/**
 * Enregistre le relais comme agent CBOR-Web (classe M2M, wallet obligatoire).
 * 1. GET /api/cbor-web/challenge (header X-CBOR-Web-Wallet) → nonce serveur à usage unique.
 * 2. Signature EIP-191 de "POST:/api/cbor-web/register:{challenge}".
 * 3. POST /api/cbor-web/register avec le challenge dans le header X-CBOR-Web-Nonce
 *    ET dans body.nonce (rétrocompat source du nonce côté serveur).
 */
export async function register({ api, wallet, displayName, privateKey, webhookUrl, isPublic }) {
  const base = String(api).replace(/\/+$/, '')

  let challenge
  try {
    const res = await fetchChallenge(base, wallet)
    if (!res.ok) return { ok: false, error: res.error }
    challenge = res.challenge
  } catch (err) {
    if (isTimeout(err)) return { ok: false, error: 'timeout' }
    return { ok: false, error: `challenge fetch échoué: ${err.message}` }
  }

  const message = `POST:/api/cbor-web/register:${challenge}`
  const signature = signEIP191(message, privateKey)
  const payload = {
    wallet_address: wallet,
    display_name: displayName,
    webhook_url: webhookUrl ?? undefined,
    is_public: isPublic === true,
    nonce: challenge,
    signature,
  }

  let res
  try {
    res = await fetch(`${base}/api/cbor-web/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CBOR-Web-Wallet': wallet,
        'X-CBOR-Web-Sig': signature,
        'X-CBOR-Web-Nonce': challenge,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    return { ok: false, error: `fetch échoué: ${err.message}` }
  }
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status }
  }
  let body = null
  try { body = JSON.parse(text) } catch { /* réponse non-JSON : acceptée */ }
  return { ok: true, status: res.status, body }
}

/**
 * Poste la réponse du relais en CBOR-Web signé (remplace l'ancien chemin webhook HMAC sortant).
 * La signature couvre "POST:/api/cbor-web/messages:{challenge}:{sha256(body)}" :
 * le challenge (anti-rejeu) ET le corps exact envoyé (anti-substitution).
 */
export async function postReply({ api, wallet, privateKey, conversationId, message }) {
  const base = String(api).replace(/\/+$/, '')
  const payload = { conversation_id: conversationId, content: String(message).slice(0, MAX_MESSAGE_CHARS) }
  const bodyStr = JSON.stringify(payload)
  const bodyHash = sha256Hex(new TextEncoder().encode(bodyStr))

  let challenge
  try {
    const res = await fetchChallenge(base, wallet)
    if (!res.ok) return { ok: false, error: res.error, status: res.status }
    challenge = res.challenge
  } catch (err) {
    if (isTimeout(err)) return { ok: false, error: 'timeout', retryable: true }
    return { ok: false, error: `challenge fetch échoué: ${err.message}`, retryable: true }
  }

  const messageToSign = `POST:/api/cbor-web/messages:${challenge}:${bodyHash}`
  const signature = signEIP191(messageToSign, privateKey)

  let res
  try {
    res = await fetch(`${base}/api/cbor-web/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CBOR-Web-Wallet': wallet,
        'X-CBOR-Web-Sig': signature,
        'X-CBOR-Web-Nonce': challenge,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    if (isTimeout(err)) return { ok: false, error: 'timeout', retryable: true }
    return { ok: false, error: `fetch échoué: ${err.message}`, retryable: true }
  }
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status }
  }
  let body = null
  try { body = JSON.parse(text) } catch { /* réponse non-JSON : acceptée */ }
  return { ok: true, status: res.status, body }
}
