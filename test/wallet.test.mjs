import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateWallet, signEIP191, recoverAddress } from '../src/wallet.mjs'

test('generateWallet returns a valid secp256k1 wallet', () => {
  const wallet = generateWallet()
  assert.match(wallet.privateKey, /^[0-9a-f]{64}$/)
  assert.match(wallet.address, /^0x[0-9a-f]{40}$/)
  assert.equal(wallet.address, wallet.address.toLowerCase())
})

test('round-trip: signEIP191 then recoverAddress returns the wallet address', () => {
  const wallet = generateWallet()
  const message = 'POST:/api/cbor-web/messages:challenge-uuid:deadbeef'
  const signature = signEIP191(message, wallet.privateKey)
  // 0x + 65 bytes (64 compact + 1 recovery byte)
  assert.match(signature, /^0x[0-9a-f]{130}$/)
  assert.equal(recoverAddress(message, signature), wallet.address)
})

test('tampered signature does not recover to the wallet address', () => {
  const wallet = generateWallet()
  const message = 'POST:/api/cbor-web/messages:challenge-uuid:deadbeef'
  const signature = signEIP191(message, wallet.privateKey)
  // Flip one nibble in the middle of the r part to falsify the signature.
  const hex = signature.slice(2)
  const flipped = hex.slice(0, 40) + (parseInt(hex[40], 16) ^ 1).toString(16) + hex.slice(41)
  assert.notEqual(recoverAddress(message, '0x' + flipped), wallet.address)
})
