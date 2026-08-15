import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { postReply, MAX_MESSAGE_CHARS } from '../src/mesgia-client.mjs'

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('postReply : chemin, auth, corps corrects', async () => {
  let captured = null
  const server = await startStub((req, res) => {
    let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => {
      captured = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message_id: 'm-1' }))
    })
  })
  const port = server.address().port
  const r = await postReply({ apiUrl: `http://127.0.0.1:${port}`, agentId: 'agent-1', apiKey: 'cle-1', conversationId: 'conv-1', message: 'bonjour' })
  server.close()
  assert.deepEqual(r, { ok: true, status: 200, body: { message_id: 'm-1' } })
  assert.equal(captured.method, 'POST')
  assert.equal(captured.url, '/api/webhooks/agent-1')
  assert.equal(captured.auth, 'Bearer cle-1')
  assert.deepEqual(captured.body, { conversation_id: 'conv-1', message: 'bonjour' })
})

test('postReply : message borné à 5000 caractères', async () => {
  let captured = null
  const server = await startStub((req, res) => {
    let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => {
      captured = JSON.parse(b)
      res.writeHead(200); res.end('{}')
    })
  })
  const port = server.address().port
  await postReply({ apiUrl: `http://127.0.0.1:${port}`, agentId: 'a', apiKey: 'k', conversationId: 'c', message: 'x'.repeat(6000) })
  server.close()
  assert.equal(captured.message.length, MAX_MESSAGE_CHARS)
  assert.equal(MAX_MESSAGE_CHARS, 5000)
})

test('postReply : HTTP 401 → ok:false', async () => {
  const server = await startStub((req, res) => { res.writeHead(401); res.end('{"error":"Non autorisé"}') })
  const port = server.address().port
  const r = await postReply({ apiUrl: `http://127.0.0.1:${port}`, agentId: 'a', apiKey: 'mauvaise', conversationId: 'c', message: 'm' })
  server.close()
  assert.equal(r.ok, false)
  assert.match(r.error, /401/)
})

test('postReply : apiUrl avec slash final accepté', async () => {
  let url = null
  const server = await startStub((req, res) => { url = req.url; res.writeHead(200); res.end('{}') })
  const port = server.address().port
  await postReply({ apiUrl: `http://127.0.0.1:${port}/`, agentId: 'a', apiKey: 'k', conversationId: 'c', message: 'm' })
  server.close()
  assert.equal(url, '/api/webhooks/a')
})
