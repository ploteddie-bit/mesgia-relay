import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { invokeBrain, MAX_STDERR_CHARS } from '../src/brain.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))

test('M2 : un extrait de stderr remonte dans le message d erreur', async () => {
  const fixture = path.join(dir, 'fixtures/fail-stderr.mjs')
  const r = await invokeBrain('x', { bin: process.execPath, args: [fixture] })
  assert.equal(r.ok, false)
  assert.match(r.error, /exit code 1/)
  assert.ok(r.error.includes('ERREUR_SPECIFIQUE_DE_TEST'), `stderr attendu dans l'erreur, reçu : ${r.error}`)
})

test('M2 : le buffer stderr garde la FIN du flux (préfixe au-delà de la borne ignoré, extrait ≤ 500)', async () => {
  const fixture = path.join(dir, 'fixtures/fail-stderr-long.mjs')
  const r = await invokeBrain('x', { bin: process.execPath, args: [fixture] })
  assert.equal(r.ok, false)
  assert.match(r.error, /exit code 1/)
  // F5 : on conserve la fin du flux → le marqueur de FIN est présent, le PRÉFIXE est ignoré.
  assert.ok(r.error.includes('FIN_MARQUEUR'), 'la fin du stderr est conservée')
  assert.ok(!r.error.includes('DEBUT_MARQUEUR'), 'le préfixe au-delà de la borne est ignoré')
  const after = r.error.slice(r.error.indexOf(': ') + 2)
  assert.ok(after.length > 0, 'un extrait du stderr doit être présent')
  assert.ok(after.length <= 500, `extrait borné à 500 chars, reçu ${after.length}`)
})

test('M1 : au timeout, le GROUPE de process est tué (l enfant du cerveau ne survit pas)', async () => {
  const fixture = path.join(dir, 'fixtures/spawns-child.mjs')
  const pidFile = path.join(os.tmpdir(), `mesgia-relay-child-${process.pid}-${Date.now()}.pid`)

  const r = await invokeBrain('x', { bin: process.execPath, args: [fixture, pidFile], timeoutMs: 300 })
  assert.equal(r.ok, false)
  assert.match(r.error, /timeout/)

  // Attend que le PID du grandchild soit écrit.
  let childPid = null
  for (let i = 0; i < 100; i++) {
    try {
      childPid = Number(readFileSync(pidFile, 'utf8').trim())
      break
    } catch { await new Promise((res) => setTimeout(res, 10)) }
  }
  assert.ok(Number.isFinite(childPid), 'le PID du grandchild a bien été écrit')

  // process.kill(pid, 0) lève ESRCH quand le process n'existe plus.
  let alive = true
  for (let i = 0; i < 100; i++) {
    try { process.kill(childPid, 0) } catch (err) { if (err.code === 'ESRCH') { alive = false; break } }
    await new Promise((res) => setTimeout(res, 20))
  }
  assert.equal(alive, false, 'le grandchild doit être tué avec le groupe de process')
})

test('M2 : MAX_STDERR_CHARS vaut bien 4000', () => {
  assert.equal(MAX_STDERR_CHARS, 4000)
})
