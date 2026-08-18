import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createRelayServer } from '../src/server.mjs'

const SECRET = 'secret-retry-32-caracteres-xx'

function sign(ts, body) {
  return 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')
}

function startRelay({ postReply, deadLetter, retryDelayMs = 1, logs = [] }) {
  const relay = createRelayServer({
    secret: SECRET,
    brain: async () => ({ ok: true, reply: 'RÉPONSE' }),
    postReply,
    deadLetter,
    retryDelayMs,
    log: (m) => logs.push(m),
  })
  return new Promise((resolve) => relay.listen(0, '127.0.0.1', () => resolve(relay)))
}

async function post(port, body) {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = sign(ts, body)
  return fetch(`http://127.0.0.1:${port}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mesgia-Signature': sig, 'X-Mesgia-Timestamp': ts },
    body,
  })
}

test('M6 : un premier échec postReply est retenté une fois puis réussit', async () => {
  let attempts = 0
  const relay = await startRelay({
    postReply: async () => {
      attempts++
      if (attempts === 1) return { ok: false, error: 'HTTP 500' }
      return { ok: true, status: 200, body: null }
    },
  })
  const port = relay.address().port
  const body = JSON.stringify({ event: 'message.created', conversation_id: 'conv-retry', message: 'm' })

  const res = await post(port, body)
  assert.equal(res.status, 200)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(attempts, 2)

  relay.close()
})

test('M6 : si le retry échoue aussi, la réponse perdue est écrite en dead-letter', async () => {
  let deadLetterArgs = null
  const logs = []
  const relay = await startRelay({
    postReply: async () => ({ ok: false, error: 'HTTP 503' }),
    deadLetter: async (args) => { deadLetterArgs = args },
    logs,
  })
  const port = relay.address().port
  const body = JSON.stringify({ event: 'message.created', conversation_id: 'conv-dl', message: 'm' })

  await post(port, body)
  await new Promise((r) => setTimeout(r, 100))

  assert.ok(deadLetterArgs, 'dead-letter doit être appelé')
  assert.equal(deadLetterArgs.conversationId, 'conv-dl')
  assert.equal(deadLetterArgs.reply, 'RÉPONSE')
  assert.equal(deadLetterArgs.error, 'HTTP 503')
  assert.ok(logs.some((l) => l.includes('dead-letter écrit')), 'un log explicite est attendu')

  relay.close()
})

test('M6 F4 : un 4xx définitif n est pas retenté (dead-letter direct, 1 seul appel)', async () => {
  let attempts = 0
  let deadLetterArgs = null
  const relay = await startRelay({
    postReply: async () => {
      attempts++
      return { ok: false, error: 'HTTP 401: Non autorisé', status: 401 }
    },
    deadLetter: async (args) => { deadLetterArgs = args },
  })
  const port = relay.address().port
  const body = JSON.stringify({ event: 'message.created', conversation_id: 'conv-4xx', message: 'm' })

  await post(port, body)
  await new Promise((r) => setTimeout(r, 100))

  assert.equal(attempts, 1)
  assert.ok(deadLetterArgs, 'dead-letter doit être appelé sans retry')
  assert.equal(deadLetterArgs.conversationId, 'conv-4xx')
  assert.equal(deadLetterArgs.error, 'HTTP 401: Non autorisé')

  relay.close()
})
