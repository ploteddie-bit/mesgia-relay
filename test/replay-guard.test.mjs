import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReplayGuard, DEFAULT_REPLAY_TTL_MS } from '../src/replay-guard.mjs'

test('checkAndRecord : première occurrence acceptée, rejeu rejeté, clé différente acceptée', () => {
  const guard = createReplayGuard()
  assert.equal(guard.checkAndRecord('sig-1'), false)
  assert.equal(guard.checkAndRecord('sig-1'), true)   // rejeu
  assert.equal(guard.checkAndRecord('sig-2'), false)  // clé différente (message différent)
})

test('purge : une entrée expirée est oubliée, le rejeu redevient possible', () => {
  let fakeNow = 0
  const guard = createReplayGuard({ now: () => fakeNow, ttlMs: 1000 })
  assert.equal(guard.checkAndRecord('sig-a'), false)
  fakeNow = 1500
  assert.equal(guard.checkAndRecord('sig-a'), false) // expirée → acceptée à nouveau
})

test('persistance : les clés survivent à une ré-instantiation sur le même fichier', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-guard-'))
  const file = path.join(dir, 'seen.json')

  const g1 = createReplayGuard({ filePath: file })
  assert.equal(g1.checkAndRecord('sig-persist'), false)

  const g2 = createReplayGuard({ filePath: file })
  assert.equal(g2.checkAndRecord('sig-persist'), true)

  // Le fichier contient bien l'entrée persistée.
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(raw.entries.some((e) => e.k === 'sig-persist'))
})

test('écriture atomique : pas de fichier temporaire résiduel après écriture', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-guard-'))
  const file = path.join(dir, 'seen.json')

  const guard = createReplayGuard({ filePath: file })
  guard.checkAndRecord('sig-tmp')

  assert.ok(existsSync(file))
  assert.ok(!existsSync(`${file}.tmp`))
})

test('défaut : TTL anti-rejeu = 10 minutes', () => {
  assert.equal(DEFAULT_REPLAY_TTL_MS, 10 * 60 * 1000)
})
