import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { generateWallet, recoverAddress } from '../src/wallet.mjs'
import { register, postReply, deriveAddress, MAX_MESSAGE_CHARS } from '../src/cbor-client.mjs'

const API = 'http://stub.example.test'

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

// Remplace global.fetch par un handler qui capture chaque appel (url, method, headers, body).
function mockFetch(handler) {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ?? null }
    calls.push(call)
    return handler(call)
  }
  return { calls, restore: () => { global.fetch = original } }
}

function stubMesgia(challenge) {
  return mockFetch((call) => {
    if (call.url.endsWith('/api/cbor-web/challenge')) {
      return new Response(JSON.stringify({ challenge, expires_at: '2026-08-16T00:00:00.000Z' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (call.url.endsWith('/api/cbor-web/register')) {
      return new Response(JSON.stringify({ participant_id: 'p-1', wallet_address: call.headers['X-CBOR-Web-Wallet'], display_name: 'Relais' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (call.url.endsWith('/api/cbor-web/messages')) {
      return new Response(JSON.stringify({ message_id: 'm-1', conversation_id: 'conv-9', status: 'sent' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 500 })
  })
}

test('register : GET challenge avec header wallet, signature couvre POST:/api/cbor-web/register:{challenge}', async () => {
  const wallet = generateWallet()
  const { calls, restore } = stubMesgia('challenge-reg-1')
  const r = await register({ api: API, wallet: wallet.address, displayName: 'Relais Test', privateKey: wallet.privateKey })
  restore()

  assert.equal(r.ok, true)
  assert.equal(r.status, 201)
  assert.equal(r.body.participant_id, 'p-1')

  // 1) GET challenge avec l'en-tête X-CBOR-Web-Wallet
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'GET')
  assert.ok(calls[0].url.endsWith('/api/cbor-web/challenge'))
  assert.equal(calls[0].headers['X-CBOR-Web-Wallet'], wallet.address)

  // 2) POST register : headers + body
  const reg = calls[1]
  assert.equal(reg.method, 'POST')
  assert.ok(reg.url.endsWith('/api/cbor-web/register'))
  assert.equal(reg.headers['X-CBOR-Web-Wallet'], wallet.address)
  assert.equal(reg.headers['X-CBOR-Web-Nonce'], 'challenge-reg-1')
  assert.equal(reg.headers['X-CBOR-Web-Sig'], reg.body ? JSON.parse(reg.body).signature : undefined)
  assert.deepEqual(JSON.parse(reg.body), {
    wallet_address: wallet.address,
    display_name: 'Relais Test',
    nonce: 'challenge-reg-1',
    signature: reg.headers['X-CBOR-Web-Sig'],
  })

  // 3) La signature couvre bien POST:/api/cbor-web/register:{challenge}
  const sig = reg.headers['X-CBOR-Web-Sig']
  assert.equal(recoverAddress('POST:/api/cbor-web/register:challenge-reg-1', sig), wallet.address)
})

test('postReply : signature couvre POST:/api/cbor-web/messages:{challenge}:{sha256(body)} et header wallet', async () => {
  const wallet = generateWallet()
  const { calls, restore } = stubMesgia('challenge-msg-1')
  const r = await postReply({ api: API, wallet: wallet.address, privateKey: wallet.privateKey, conversationId: 'conv-9', message: 'bonjour relais' })
  restore()

  assert.equal(r.ok, true)
  assert.equal(r.status, 200)
  assert.equal(r.body.message_id, 'm-1')

  // 1) GET challenge avec l'en-tête wallet
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers['X-CBOR-Web-Wallet'], wallet.address)

  // 2) POST messages : headers
  const msg = calls[1]
  assert.equal(msg.method, 'POST')
  assert.ok(msg.url.endsWith('/api/cbor-web/messages'))
  assert.equal(msg.headers['X-CBOR-Web-Wallet'], wallet.address)
  assert.equal(msg.headers['X-CBOR-Web-Nonce'], 'challenge-msg-1')

  // 3) Le body réellement envoyé (celui que le serveur hachera) doit être couvert par la signature
  const bodyHash = sha256Hex(new TextEncoder().encode(msg.body))
  const signedMessage = `POST:/api/cbor-web/messages:challenge-msg-1:${bodyHash}`
  assert.equal(recoverAddress(signedMessage, msg.headers['X-CBOR-Web-Sig']), wallet.address)

  // et le body est bien { conversation_id, content }
  assert.deepEqual(JSON.parse(msg.body), { conversation_id: 'conv-9', content: 'bonjour relais' })
})

test('postReply : message borné à 5000 caractères AVANT signature (body signé = body envoyé)', async () => {
  const wallet = generateWallet()
  const { calls, restore } = stubMesgia('challenge-msg-2')
  await postReply({ api: API, wallet: wallet.address, privateKey: wallet.privateKey, conversationId: 'c', message: 'x'.repeat(6000) })
  restore()

  const msg = calls[1]
  assert.equal(JSON.parse(msg.body).content.length, MAX_MESSAGE_CHARS)
  assert.equal(MAX_MESSAGE_CHARS, 5000)
  const bodyHash = sha256Hex(new TextEncoder().encode(msg.body))
  assert.equal(recoverAddress(`POST:/api/cbor-web/messages:challenge-msg-2:${bodyHash}`, msg.headers['X-CBOR-Web-Sig']), wallet.address)
})

test('deriveAddress(privateKey) === generateWallet().address', () => {
  const wallet = generateWallet()
  assert.equal(deriveAddress(wallet.privateKey), wallet.address)
})

test('challenge serveur en échec (500) → ok:false, aucun POST envoyé', async () => {
  const wallet = generateWallet()
  const { calls, restore } = mockFetch((call) => {
    if (call.url.endsWith('/api/cbor-web/challenge')) {
      return new Response('{"error":"Limite de débit atteinte"}', { status: 429, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 500 })
  })
  const r = await postReply({ api: API, wallet: wallet.address, privateKey: wallet.privateKey, conversationId: 'c', message: 'm' })
  restore()

  assert.equal(r.ok, false)
  assert.match(r.error, /429/)
  assert.equal(calls.length, 1) // seulement le GET challenge, pas de POST
})
