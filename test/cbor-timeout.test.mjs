import test from 'node:test'
import assert from 'node:assert/strict'
import { postReply, FETCH_TIMEOUT_MS } from '../src/cbor-client.mjs'
import { generateWallet } from '../src/wallet.mjs'

const API = 'http://stub.example.test'

function mockFetch(handler) {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body ?? null,
      signal: opts.signal ?? null,
    }
    calls.push(call)
    return handler(call)
  }
  return { calls, restore: () => { global.fetch = original } }
}

test('M3 : un AbortSignal est passé au challenge ET au POST messages', async () => {
  const wallet = generateWallet()
  const { calls, restore } = mockFetch((call) => {
    if (call.url.endsWith('/api/cbor-web/challenge')) {
      return new Response(JSON.stringify({ challenge: 'c' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (call.url.endsWith('/api/cbor-web/messages')) {
      return new Response(JSON.stringify({ message_id: 'm' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 500 })
  })

  await postReply({ api: API, wallet: wallet.address, privateKey: wallet.privateKey, conversationId: 'c', message: 'm' })
  restore()

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.ok(call.signal, `signal manquant pour ${call.url}`)
    assert.equal(typeof call.signal.aborted, 'boolean')
  }
})

test('M3 : timeout du challenge → {ok:false, error:timeout}', async () => {
  const wallet = generateWallet()
  const { restore } = mockFetch(() => {
    const err = new Error('The operation was aborted due to timeout')
    err.name = 'TimeoutError'
    return Promise.reject(err)
  })

  const r = await postReply({ api: API, wallet: wallet.address, privateKey: wallet.privateKey, conversationId: 'c', message: 'm' })
  restore()

  assert.equal(r.ok, false)
  assert.equal(r.error, 'timeout')
})

test('M3 : timeout du POST messages → {ok:false, error:timeout} (après un challenge OK)', async () => {
  const wallet = generateWallet()
  const { calls, restore } = mockFetch((call) => {
    if (call.url.endsWith('/api/cbor-web/challenge')) {
      return new Response(JSON.stringify({ challenge: 'c' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const err = new Error('aborted')
    err.name = 'AbortError'
    return Promise.reject(err)
  })

  const r = await postReply({ api: API, wallet: wallet.address, privateKey: wallet.privateKey, conversationId: 'c', message: 'm' })
  restore()

  assert.equal(r.ok, false)
  assert.equal(r.error, 'timeout')
  assert.equal(calls.length, 2) // challenge + POST
})

test('M3 : FETCH_TIMEOUT_MS vaut 10 secondes', () => {
  assert.equal(FETCH_TIMEOUT_MS, 10_000)
})
