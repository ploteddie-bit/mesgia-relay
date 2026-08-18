import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createRelayServer } from '../src/server.mjs'
import { createReplayGuard } from '../src/replay-guard.mjs'

const SECRET = 'secret-replay-32-caracteres-xx'

function sign(ts, body) {
  return 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')
}

function startRelay() {
  const relay = createRelayServer({
    secret: SECRET,
    brain: async () => ({ ok: true, reply: 'R' }),
    postReply: async () => ({ ok: true, status: 200, body: null }),
    replayGuard: createReplayGuard(), // mémoire : isole les tests du data/ réel
  })
  return new Promise((resolve) => relay.listen(0, '127.0.0.1', () => resolve(relay)))
}

async function post(port, { ts, body, nonce }) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Mesgia-Signature': sign(ts, body),
    'X-Mesgia-Timestamp': ts,
  }
  if (nonce) headers['X-Mesgia-Nonce'] = nonce
  return fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers, body })
}

test('P1-1 : rejeu à l identique → 409 ; même timestamp + contenu différent → 200', async () => {
  const relay = await startRelay()
  const port = relay.address().port
  const ts = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({ event: 'message.created', conversation_id: 'conv-r1', message: 'm' })

  const first = await post(port, { ts, body })
  assert.equal(first.status, 200)

  // Rejeu exact (même signature) → rejeté.
  const replay = await post(port, { ts, body })
  assert.equal(replay.status, 409)
  assert.match(await replay.text(), /rejoué/)

  // Même timestamp mais corps différent → signature différente → accepté.
  const body2 = JSON.stringify({ event: 'message.created', conversation_id: 'conv-r2', message: 'autre' })
  const other = await post(port, { ts, body: body2 })
  assert.equal(other.status, 200)

  relay.close()
})

test('P1-1 : nonce explicite — un nonce déjà vu est rejeté même si signature/timestamp changent', async () => {
  const relay = await startRelay()
  const port = relay.address().port
  const ts1 = String(Math.floor(Date.now() / 1000))
  const body1 = JSON.stringify({ event: 'message.created', conversation_id: 'conv-n1', message: 'm' })

  const first = await post(port, { ts: ts1, body: body1, nonce: 'nonce-unique-1' })
  assert.equal(first.status, 200)

  const ts2 = String(Math.floor(Date.now() / 1000) + 1)
  const body2 = JSON.stringify({ event: 'message.created', conversation_id: 'conv-n2', message: 'autre' })
  const replay = await post(port, { ts: ts2, body: body2, nonce: 'nonce-unique-1' })
  assert.equal(replay.status, 409)

  relay.close()
})

test('P1-1 F1 : nonce modifié mais même signature/timestamp/body → 409 (clé authentifiée toujours enregistrée)', async () => {
  const relay = await startRelay()
  const port = relay.address().port
  const ts = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({ event: 'message.created', conversation_id: 'conv-f1', message: 'm' })

  const first = await post(port, { ts, body, nonce: 'nonce-original' })
  assert.equal(first.status, 200)

  // Même corps/timestamp (donc même signature HMAC), nonce modifié : doit être rejeté.
  const replay = await post(port, { ts, body, nonce: 'nonce-modifie' })
  assert.equal(replay.status, 409)
  assert.match(await replay.text(), /rejoué/)

  relay.close()
})
