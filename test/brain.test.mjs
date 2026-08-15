import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildPrompt, parseBrainStdout, invokeBrain, MAX_INPUT_CHARS, PROMPT_PREFIX } from '../src/brain.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))

test('buildPrompt : préfixe + borne 4000 caractères', () => {
  const long = 'a'.repeat(5000)
  const p = buildPrompt(long)
  assert.ok(p.startsWith(PROMPT_PREFIX))
  assert.equal(p.length, PROMPT_PREFIX.length + MAX_INPUT_CHARS)
})

test('parseBrainStdout : le dernier événement assistant non vide gagne', () => {
  const stdout = readFileSync(path.join(dir, 'fixtures/stream-ok.jsonl'), 'utf8')
  assert.equal(parseBrainStdout(stdout), 'PONG')
})

test('parseBrainStdout : aucun assistant → null', () => {
  const stdout = readFileSync(path.join(dir, 'fixtures/stream-empty.jsonl'), 'utf8')
  assert.equal(parseBrainStdout(stdout), null)
})

test('invokeBrain : succès via cerveau factice', async () => {
  const fake = path.join(dir, 'fixtures/fake-brain.mjs')
  const r = await invokeBrain('message ignoré', { bin: process.execPath, args: [fake] })
  assert.deepEqual(r, { ok: true, reply: 'PONG' })
})

test('invokeBrain : timeout → ok:false', async () => {
  const slow = path.join(dir, 'fixtures/slow-brain.mjs')
  const r = await invokeBrain('x', { bin: process.execPath, args: [slow], timeoutMs: 300 })
  assert.equal(r.ok, false)
  assert.match(r.error, /timeout/)
})

test('invokeBrain : exit non-zéro → ok:false', async () => {
  const fail = path.join(dir, 'fixtures/fail-brain.mjs')
  const r = await invokeBrain('x', { bin: process.execPath, args: [fail] })
  assert.equal(r.ok, false)
  assert.match(r.error, /exit code/)
})
