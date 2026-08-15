import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { createRelayServer } from '../src/server.mjs'

const SECRET = 'secret-integration-32-caracteres'

function startStubMesgia() {
  const received = []
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(b) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message_id: 'm-stub' }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })))
}

function signedFetch(port, body, { secret = SECRET, skew = 0, path = '/webhook' } = {}) {
  const ts = String(Math.floor((Date.now() + skew) / 1000))
  const sig = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mesgia-Signature': sig, 'X-Mesgia-Timestamp': ts },
    body,
  })
}

async function waitFor(cond, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

test('HMAC valide → ack immédiat sans reply, puis réponse postée', async () => {
  const stub = await startStubMesgia()
  const relay = createRelayServer({
    secret: SECRET,
    brain: async () => ({ ok: true, reply: 'RÉPONSE DU CERVEAU' }),
    postReply: ({ conversationId, message }) =>
      fetch(`http://127.0.0.1:${stub.port}/api/webhooks/agent-t`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, message }),
      }).then((r) => ({ ok: r.ok, status: r.status, body: null })),
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const port = relay.address().port

  const body = JSON.stringify({ event: 'message.created', conversation_id: 'conv-9', message: 'bonjour relais' })
  const res = await signedFetch(port, body)
  const ack = await res.json()
  assert.equal(res.status, 200)
  assert.deepEqual(ack, { ok: true })          // SANS champ reply
  assert.equal('reply' in ack, false)

  assert.ok(await waitFor(() => stub.received.length === 1))
  assert.equal(stub.received[0].body.conversation_id, 'conv-9')
  assert.equal(stub.received[0].body.message, 'RÉPONSE DU CERVEAU')
  relay.close(); stub.server.close()
})

test('HMAC invalide → 401 et cerveau JAMAIS appelé', async () => {
  let brainCalls = 0
  const relay = createRelayServer({
    secret: SECRET,
    brain: async () => { brainCalls++; return { ok: true, reply: 'x' } },
    postReply: async () => ({ ok: true, status: 200, body: null }),
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const port = relay.address().port
  const body = JSON.stringify({ event: 'message.created', conversation_id: 'c', message: 'm' })
  const res = await signedFetch(port, body, { secret: 'mauvais-secret-32-caracteres-xxx' })
  assert.equal(res.status, 401)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(brainCalls, 0)
  relay.close()
})

test('cerveau en échec → message fallback posté', async () => {
  const stub = await startStubMesgia()
  const relay = createRelayServer({
    secret: SECRET,
    brain: async () => ({ ok: false, error: 'timeout cerveau' }),
    postReply: ({ conversationId, message }) =>
      fetch(`http://127.0.0.1:${stub.port}/api/webhooks/agent-t`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, message }),
      }).then((r) => ({ ok: r.ok, status: r.status, body: null })),
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const port = relay.address().port
  const body = JSON.stringify({ event: 'message.created', conversation_id: 'conv-f', message: 'm' })
  await signedFetch(port, body)
  assert.ok(await waitFor(() => stub.received.length === 1))
  assert.match(stub.received[0].body.message, /cerveau n'a pas répondu/)
  relay.close(); stub.server.close()
})

test('GET /healthz → ok', async () => {
  const relay = createRelayServer({
    secret: SECRET,
    brain: async () => ({ ok: true, reply: 'x' }),
    postReply: async () => ({ ok: true, status: 200, body: null }),
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${relay.address().port}/healthz`)
  assert.deepEqual(await res.json(), { ok: true })
  relay.close()
})
