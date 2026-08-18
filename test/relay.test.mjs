import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(dir, '..')
const relayPath = path.join(root, 'relay.mjs')

// relay.mjs fait process.exit(1) au chargement sur configuration invalide :
// on le lance comme sous-processus avec un env contrôlé (process.env a priorité
// sur le .env chargé par relay.mjs) et on assert sur le code de sortie + stderr.

test('relay.mjs : variables requises manquantes → exit 1', () => {
  const env = { ...process.env, MESGIA_API: '', MESGIA_WALLET_KEY: '', MESGIA_WEBHOOK_SECRET: '' }
  const r = spawnSync(process.execPath, [relayPath], { cwd: root, env, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Variables manquantes/)
})

test('relay.mjs : BRAIN_MODE invalide → exit 1', () => {
  const env = {
    ...process.env,
    MESGIA_API: 'dummy',
    MESGIA_WALLET_KEY: 'dummy',
    MESGIA_WEBHOOK_SECRET: 'dummy',
    BRAIN_MODE: 'invalide',
  }
  const r = spawnSync(process.execPath, [relayPath], { cwd: root, env, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /BRAIN_MODE invalide/)
})
