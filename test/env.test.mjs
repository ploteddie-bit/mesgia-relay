import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadDotEnv } from '../src/env.mjs'

function tmpFile(content) {
  const p = path.join(os.tmpdir(), `mesgia-relay-env-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.env`)
  writeFileSync(p, content)
  return p
}

test('loadDotEnv : fichier absent → {}', () => {
  const p = path.join(os.tmpdir(), `mesgia-relay-env-absent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.env`)
  assert.deepEqual(loadDotEnv(p), {})
})

test('loadDotEnv : parsing clé=valeur et espaces autour du =', () => {
  const p = tmpFile('A=1\nB = 2\n C=3 ')
  assert.deepEqual(loadDotEnv(p), { A: '1', B: '2', C: '3' })
})

test('loadDotEnv : lignes vides, commentaires et lignes sans = ignorés', () => {
  const p = tmpFile('\n# commentaire\nA=1\nligne-sans-egal\n   \n# autre\nB=2\n')
  assert.deepEqual(loadDotEnv(p), { A: '1', B: '2' })
})

test('loadDotEnv : guillemets conservés tels quels (pas de strip)', () => {
  const p = tmpFile('A="bonjour"\nB=\'salut\'')
  assert.deepEqual(loadDotEnv(p), { A: '"bonjour"', B: "'salut'" })
})
