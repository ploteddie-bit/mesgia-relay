import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export const MAX_INPUT_CHARS = 4000
export const DEFAULT_TIMEOUT_MS = 120_000
export const PROMPT_PREFIX =
  "Tu es Relais-Kimi, un agent de la messagerie Mesgia. Réponds directement au message ci-dessous, en français, de façon concise. N'utilise aucun outil, ne lance aucune commande, produis uniquement le texte de ta réponse. Message : "

export function buildPrompt(message) {
  return PROMPT_PREFIX + String(message).slice(0, MAX_INPUT_CHARS)
}

/** Dernier événement role==="assistant" à contenu non vide ; null sinon. */
export function parseBrainStdout(stdout) {
  let reply = null
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let evt
    try { evt = JSON.parse(trimmed) } catch { continue }
    if (evt && evt.role === 'assistant' && typeof evt.content === 'string') {
      const content = evt.content.trim()
      if (content) reply = content
    }
  }
  return reply
}

/**
 * Réveille le cerveau. JAMAIS de shell ni de concaténation : le prompt passe
 * en argument de spawn (donnée non fiable).
 */
export function invokeBrain(promptText, opts = {}) {
  const bin = opts.bin ?? path.join(os.homedir(), '.kimi-code', 'bin', 'kimi')
  const args = opts.args ?? ['-p', promptText, '--output-format', 'stream-json']
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ ok: false, error: 'timeout cerveau' }) }
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: `spawn échoué: ${err.message}` }) }
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) return resolve({ ok: false, error: `exit code ${code}` })
      const reply = parseBrainStdout(stdout)
      if (!reply) return resolve({ ok: false, error: 'réponse vide du cerveau' })
      resolve({ ok: true, reply })
    })
  })
}
