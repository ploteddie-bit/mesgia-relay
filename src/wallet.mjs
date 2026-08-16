import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

export function generateWallet() {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = secp256k1.getPublicKey(privateKey, false) // uncompressed
  const address = '0x' + bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))
  return { privateKey: bytesToHex(privateKey), address }
}

export function signEIP191(message, privateKeyHex) {
  const prefix = `\x19Ethereum Signed Message:\n${message.length}`
  const msgHash = keccak_256(new TextEncoder().encode(prefix + message))
  const sig = secp256k1.sign(msgHash, hexToBytes(privateKeyHex))
  const recId = sig.recovery
  const compact = sig.toCompactRawBytes()
  return '0x' + bytesToHex(compact) + (recId + 27).toString(16).padStart(2, '0')
}

export function recoverAddress(message, signature) {
  const normalized = signature.startsWith('0x') ? signature.slice(2) : signature
  const sig = hexToBytes(normalized)
  const recId = sig[64] - 27
  const s = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(recId)
  const prefix = `\x19Ethereum Signed Message:\n${message.length}`
  const msgHash = keccak_256(new TextEncoder().encode(prefix + message))
  const pub = s.recoverPublicKey(msgHash).toRawBytes(false)
  return '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(-20))
}
