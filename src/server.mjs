import http from 'node:http'
import path from 'node:path'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { verifyMesgiaSignature } from './hmac.mjs'
import { createFifo } from './queue.mjs'
import { createReplayGuard } from './replay-guard.mjs'

const FALLBACK_REPLY = (error) =>
  `⚠️ Le cerveau n'a pas répondu (${error}). Votre message reste dans la conversation.`

// Délai de backoff avant l'unique retry de postReply (M6).
const DEFAULT_RETRY_DELAY_MS = 2_000

// Répertoire par défaut des réponses perdues (M6), dérivé du repo, pas du cwd.
const DEFAULT_DEAD_LETTER_DIR = new URL('../dead-letters', import.meta.url).pathname

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Retenter uniquement sur 5xx / réseau / timeout (jamais sur les 4xx définitifs). */
function isRetryable(posted) {
  if (posted?.retryable === true) return true
  if (typeof posted?.status === 'number') return posted.status >= 500
  const err = String(posted?.error ?? '')
  return /^timeout/.test(err) || err.includes('fetch échoué') || err.includes('challenge fetch échoué') || /HTTP 5\d\d/.test(err)
}

/**
 * Écrit une réponse perdue dans dead-letters/<ts>-<conv>.json pour rejeu manuel.
 * Crée le répertoire si besoin, écriture atomique (fichier temporaire + rename).
 * Le conversationId est assaini pour ne jamais produire un chemin invalide.
 * Aucune valeur de secret n'est écrite : uniquement le texte de réponse et l'erreur générique.
 */
export function writeDeadLetter({ conversationId, reply, error, dir = DEFAULT_DEAD_LETTER_DIR, now = Date.now } = {}) {
  const safeConv = String(conversationId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
  const ts = now()
  const file = path.join(dir, `${ts}-${safeConv}.json`)
  mkdirSync(dir, { recursive: true })
  const payload = JSON.stringify({ ts, conversationId: String(conversationId), reply, error }, null, 2)
  const tmp = `${file}.tmp`
  // Contenu conversationnel : on restreint la lecture au propriétaire (F6).
  writeFileSync(tmp, payload, { mode: 0o600 })
  renameSync(tmp, file)
  return file
}

/**
 * Crée le serveur relais.
 * @param {{ secret: string, brain: (msg: string) => Promise<{ok:boolean, reply?:string, error?:string}>, postReply: (args:{conversationId:string,message:string}) => Promise<{ok:boolean,error?:string}>, log?: (msg:string)=>void, replayGuard?: { checkAndRecord: (key:string)=>boolean }, deadLetter?: (args:{conversationId:string,reply:string,error:string})=>void|Promise<void>, retryDelayMs?: number }} deps
 * brain, postReply, replayGuard et deadLetter sont injectés (testables sans réseau ni processus réel).
 */
export function createRelayServer({ secret, brain, postReply, log = () => {}, replayGuard = createReplayGuard(), deadLetter = writeDeadLetter, retryDelayMs = DEFAULT_RETRY_DELAY_MS }) {
  const enqueue = createFifo(async ({ conversationId, message }) => {
    const result = await brain(message)
    const reply = result.ok ? result.reply : FALLBACK_REPLY(result.error ?? 'erreur inconnue')

    // M6 : un échec de postReply n'est plus définitif — 1 retry, puis dead-letter.
    // Compromis at-least-once : si le premier échec est ambigu (le POST a pu être
    // traité côté Mesgia mais la réponse perdue), le retry peut poster deux fois.
    // Accepté explicitement par le brief (1 retry), à tracer côté Mesgia si besoin.
    let posted = await postReply({ conversationId, message: reply })
    if (!posted.ok && isRetryable(posted)) {
      log(`premier échec post réponse conv=${conversationId}: ${posted.error} — retry ${retryDelayMs} ms`)
      await sleep(retryDelayMs)
      posted = await postReply({ conversationId, message: reply })
    }
    if (posted.ok) {
      log(`réponse postée conv=${conversationId} ok=${result.ok}`)
      return
    }

    log(`ÉCHEC post réponse conv=${conversationId}: ${posted.error}`)
    try {
      const file = await deadLetter({ conversationId, reply, error: posted.error })
      log(`dead-letter écrit conv=${conversationId} → ${file}`)
    } catch (err) {
      log(`dead-letter échec conv=${conversationId}: ${err?.message ?? err}`)
    }
  }, (err) => log(`erreur fifo: ${err?.message ?? err}`))

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Method not allowed' }))
    }
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const signatureHeader = req.headers['x-mesgia-signature']
      const timestampHeader = req.headers['x-mesgia-timestamp']
      const check = verifyMesgiaSignature({ signatureHeader, timestampHeader, body, secret })
      if (!check.ok) {
        log(`push rejeté: ${check.error}`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: check.error }))
      }

      // Anti-rejeu (P1-1) : on n'enregistre QUE des webhooks signés valides.
      // La clé authentifiée signature+timestamp est TOUJOURS enregistrée : le nonce
      // header n'est PAS couvert par la HMAC, il ne peut donc pas être la seule clé.
      // Si un nonce est présent, on l'enregistre EN PLUS (double clé) — F1.
      const nonce = req.headers['x-mesgia-nonce']
      const seenAuthenticated = replayGuard.checkAndRecord(`${timestampHeader}.${signatureHeader}`)
      const seenNonce = (nonce && String(nonce).trim())
        ? replayGuard.checkAndRecord(`nonce:${String(nonce).trim()}`)
        : false
      if (seenAuthenticated || seenNonce) {
        log('push rejeté: webhook rejoué (déjà vu)')
        res.writeHead(409, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'webhook rejoué (déjà vu)' }))
      }

      let event
      try { event = JSON.parse(body) } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'JSON invalide' }))
      }
      if (event.event !== 'message.created' || !event.message || !event.conversation_id) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, ignored: true }))
      }
      // Ack IMMÉDIAT, SANS champ reply (contrainte globale n°4).
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      enqueue({ conversationId: String(event.conversation_id), message: String(event.message) })
    })
  })
}
