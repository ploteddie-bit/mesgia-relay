import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyMesgiaSignature } from '../src/hmac.mjs'

const SECRET = 'secret-de-test-32-caracteres-min'
const NOW = 1_700_000_000_000
const ts = String(Math.floor(NOW / 1000))
const body = '{"event":"message.created","message":"bonjour"}'
const validSig = 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')

test('signature valide acceptée', () => {
  const r = verifyMesgiaSignature({ signatureHeader: validSig, timestampHeader: ts, body, secret: SECRET, now: NOW })
  assert.equal(r.ok, true)
})

test('signature invalide rejetée', () => {
  const r = verifyMesgiaSignature({ signatureHeader: validSig, timestampHeader: ts, body: body + 'x', secret: SECRET, now: NOW })
  assert.equal(r.ok, false)
})

test('mauvais secret rejeté', () => {
  const r = verifyMesgiaSignature({ signatureHeader: validSig, timestampHeader: ts, body, secret: 'autre-secret-32-caracteres-min!!', now: NOW })
  assert.equal(r.ok, false)
})

test('timestamp expiré rejeté (au-delà de 5 min)', () => {
  const r = verifyMesgiaSignature({ signatureHeader: validSig, timestampHeader: ts, body, secret: SECRET, now: NOW + 6 * 60 * 1000 })
  assert.equal(r.ok, false)
})

test('headers manquants rejetés', () => {
  assert.equal(verifyMesgiaSignature({ signatureHeader: undefined, timestampHeader: ts, body, secret: SECRET, now: NOW }).ok, false)
  assert.equal(verifyMesgiaSignature({ signatureHeader: validSig, timestampHeader: undefined, body, secret: SECRET, now: NOW }).ok, false)
})
