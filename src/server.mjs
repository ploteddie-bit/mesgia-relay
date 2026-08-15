import http from 'node:http'
import { verifyMesgiaSignature } from './hmac.mjs'
import { createFifo } from './queue.mjs'

const FALLBACK_REPLY = (error) =>
  `⚠️ Le cerveau n'a pas répondu (${error}). Votre message reste dans la conversation.`

/**
 * Crée le serveur relais.
 * @param {{ secret: string, brain: (msg: string) => Promise<{ok:boolean, reply?:string, error?:string}>, postReply: (args:{conversationId:string,message:string}) => Promise<{ok:boolean,error?:string}>, log?: (msg:string)=>void }} deps
 * brain et postReply sont injectés (testables sans réseau ni processus réel).
 */
export function createRelayServer({ secret, brain, postReply, log = () => {} }) {
  const enqueue = createFifo(async ({ conversationId, message }) => {
    const result = await brain(message)
    const reply = result.ok ? result.reply : FALLBACK_REPLY(result.error ?? 'erreur inconnue')
    const posted = await postReply({ conversationId, message: reply })
    log(posted.ok
      ? `réponse postée conv=${conversationId} ok=${result.ok}`
      : `ÉCHEC post réponse conv=${conversationId}: ${posted.error}`)
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
      const check = verifyMesgiaSignature({
        signatureHeader: req.headers['x-mesgia-signature'],
        timestampHeader: req.headers['x-mesgia-timestamp'],
        body, secret,
      })
      if (!check.ok) {
        log(`push rejeté: ${check.error}`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: check.error }))
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
