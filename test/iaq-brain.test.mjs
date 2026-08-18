import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  invokeBrainIAQ,
  MAX_REPLY_CHARS,
  IAQ_DEFAULT_TIMEOUT_MS,
} from '../src/iaq-brain.mjs'

const TOKEN = 'secret-token-de-test-32-caracteres'
const MODEL = 'qwen35-9b'

/**
 * Stub HTTP configurable simulant le routeur IAQ :
 *  - POST /submit        → 201 {id}
 *  - GET  /task/{id}     → état selon le script de status
 *  - GET  /task/{id}/artifact/result.html → {content, encoding}
 */
function startIaqStub({ submitStatus = 201, statuses = ['completed'], artifact = 'PONG', artifactStatus = 200, submitBody = null }) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      if (req.method === 'POST' && req.url === '/submit') {
        if (submitStatus !== 201) {
          res.writeHead(submitStatus, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Non autorisé' }))
        }
        res.writeHead(201, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ id: 'task-1' }))
      }
      const m = req.url.match(/^\/task\/([^/]+)$/)
      if (m) {
        const status = statuses.shift() ?? 'completed'
        const payload = status === 'failed'
          ? { status, error: 'erreur infer' }
          : { status }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(payload))
      }
      if (req.url.endsWith('/artifact/result.html')) {
        if (artifactStatus !== 200) {
          res.writeHead(artifactStatus, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Artifact introuvable' }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ content: artifact, encoding: 'text' }))
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })))
}

function close(stub) {
  return new Promise((r) => stub.server.close(r))
}

test('succès complet : submit 201 → running → completed → artifact', async () => {
  const stub = await startIaqStub({ statuses: ['running', 'completed'] })
  const logs = []
  const r = await invokeBrainIAQ({
    prompt: 'Bonjour', apiUrl: `http://127.0.0.1:${stub.port}`, token: TOKEN, model: MODEL,
    timeoutMs: 10_000, log: (m) => logs.push(m),
  })
  await close(stub)
  assert.deepEqual(r, { ok: true, reply: 'PONG' })
  // Le Bearer part avec le bon token
  assert.ok(stub.received.some((x) => x.auth === `Bearer ${TOKEN}`))
  // Le body submit contient l'enveloppe attendue
  const submit = stub.received.find((x) => x.method === 'POST' && x.url === '/submit')
  const parsed = JSON.parse(submit.body)
  assert.equal(parsed.type, 'inference')
  assert.equal(parsed.origin, 'mesgia-relay')
  assert.equal(parsed.priority, 'medium')
  assert.equal(parsed.model, MODEL)
  assert.equal(parsed.payload.messages[0].role, 'user')
  assert.equal(parsed.payload.messages[0].content, 'Bonjour')
})

test('401 submit → {ok:false} (le fallback server.mjs postera un message)', async () => {
  const stub = await startIaqStub({ submitStatus: 401 })
  const r = await invokeBrainIAQ({
    prompt: 'x', apiUrl: `http://127.0.0.1:${stub.port}`, token: 'mauvais-token', model: MODEL,
    timeoutMs: 10_000,
  })
  await close(stub)
  assert.equal(r.ok, false)
  assert.match(r.error, /401/)
})

test('tâche failed → {ok:false} générique, détail loggué (pas de fuite dans le fallback)', async () => {
  const stub = await startIaqStub({ statuses: ['failed'] })
  const logs = []
  const r = await invokeBrainIAQ({
    prompt: 'x', apiUrl: `http://127.0.0.1:${stub.port}`, token: TOKEN, model: MODEL,
    timeoutMs: 10_000, log: (m) => logs.push(m),
  })
  await close(stub)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'tâche IAQ failed')
  assert.ok(logs.some((l) => l.includes('erreur infer')), 'le détail de la tâche est journalisé')
})

test('artifact 404 (purge ~20 min) → {ok:false}', async () => {
  const stub = await startIaqStub({ statuses: ['completed'], artifactStatus: 404 })
  const r = await invokeBrainIAQ({
    prompt: 'x', apiUrl: `http://127.0.0.1:${stub.port}`, token: TOKEN, model: MODEL,
    timeoutMs: 10_000,
  })
  await close(stub)
  assert.equal(r.ok, false)
  assert.match(r.error, /404/)
})

test('artifact vide → {ok:false}', async () => {
  const stub = await startIaqStub({ statuses: ['completed'], artifact: '   ' })
  const r = await invokeBrainIAQ({
    prompt: 'x', apiUrl: `http://127.0.0.1:${stub.port}`, token: TOKEN, model: MODEL,
    timeoutMs: 10_000,
  })
  await close(stub)
  assert.equal(r.ok, false)
  assert.match(r.error, /vide/)
})

test('réponse bornée à 5000 caractères (limite dure Mesgia)', async () => {
  const longReply = 'a'.repeat(7000)
  const stub = await startIaqStub({ statuses: ['completed'], artifact: longReply })
  const r = await invokeBrainIAQ({
    prompt: 'x', apiUrl: `http://127.0.0.1:${stub.port}`, token: TOKEN, model: MODEL,
    timeoutMs: 10_000,
  })
  await close(stub)
  assert.equal(r.ok, true)
  assert.equal(r.reply.length, MAX_REPLY_CHARS)
  assert.equal(MAX_REPLY_CHARS, 5000)
})

test('timeout global : tâche bloquée running → {ok:false} timeout cerveau', async () => {
  const stub = await startIaqStub({ statuses: ['running', 'running', 'running'] })
  const r = await invokeBrainIAQ({
    prompt: 'x', apiUrl: `http://127.0.0.1:${stub.port}`, token: TOKEN, model: MODEL,
    timeoutMs: 800,
  })
  await close(stub)
  assert.equal(r.ok, false)
  assert.match(r.error, /timeout/)
})

test('token jamais présent dans les logs', async () => {
  const stub = await startIaqStub({ submitStatus: 401 })
  const logs = []
  await invokeBrainIAQ({
    prompt: 'x', apiUrl: `http://127.0.0.1:${stub.port}`, token: TOKEN, model: MODEL,
    timeoutMs: 10_000, log: (m) => logs.push(m),
  })
  await close(stub)
  assert.ok(logs.length > 0, 'des logs d erreur attendus')
  for (const line of logs) {
    assert.ok(!line.includes(TOKEN), `log ne doit pas contenir le token : ${line}`)
    assert.ok(!line.includes('Authorization'), 'log ne doit pas mentionner Authorization')
  }
})

test('défaut : IAQ_DEFAULT_TIMEOUT_MS raisonnable (>= 120 s, latence réelle ~90 s)', () => {
  assert.ok(IAQ_DEFAULT_TIMEOUT_MS >= 120_000)
})
