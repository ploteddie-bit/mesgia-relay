import { MAX_INPUT_CHARS } from './brain.mjs'
import { MAX_REPLY_CHARS } from './iaq-brain.mjs'

/**
 * Cerveau Ollama local (alternative phase 2 — 2026-08-18).
 *
 * Appelle directement l'Ollama de l'hôte du relais (défaut http://127.0.0.1:11434),
 * endpoint POST /api/chat {model, messages:[system,user], stream:false, keep_alive}.
 *
 * Pourquoi : le passage par IAQ Router (iaq-brain.mjs) soumet le relais temps réel
 * à la file FIFO mutualisée (verrou GPU gpu_lock_ttl_ms=300 s) — saturée en
 * permanence par email-learner et aegis-harness-codex, latence observée > 300 s
 * (timeouts cerveau du 2026-08-18 soir, cf. ledger W3). En local CPU,
 * qwen2.5:3b ≈ 20 tok/s et qwen2.5:7b-q4 ≈ 8-12 tok/s : une réponse de
 * messagerie tient en quelques secondes, sans file ni verrou.
 *
 * Règles identiques à iaq-brain : pas de secret à journaliser (Ollama local,
 * sans auth) ; le détail des erreurs part dans `log`, le message retourné reste
 * générique (il peut transiter vers le fallback posté sur Mesgia) ; fetch borné
 * par un AbortSignal (M3) ; entrée et sortie bornées (MAX_INPUT_CHARS /
 * MAX_REPLY_CHARS).
 */

export const OLLAMA_DEFAULT_TIMEOUT_MS = 60_000 // CPU local : 7B-q4 ≈ 8-12 tok/s
export const OLLAMA_DEFAULT_NUM_PREDICT = 256 // messagerie courte ; 256 tok ≈ 27 s à 9,5 tok/s → marge 2x sous le timeout

/**
 * @param {{ prompt?: string, systemPrompt?: string, userMessage?: string,
 *           apiUrl: string, model: string, keepAlive?: string,
 *           numPredict?: number, timeoutMs?: number,
 *           log?: (msg: string) => void }} args
 * @returns {Promise<{ok: true, reply: string} | {ok: false, error: string}>}
 */
export async function invokeBrainOllama({
  prompt, systemPrompt, userMessage,
  apiUrl, model,
  keepAlive = '4h',
  numPredict = OLLAMA_DEFAULT_NUM_PREDICT,
  timeoutMs = OLLAMA_DEFAULT_TIMEOUT_MS,
  log = () => {},
}) {
  // Anti-injection (P1-2) : identique à iaq-brain — consignes en system, contenu
  // utilisateur borné en user. Rétrocompat `prompt` (un seul message user).
  const messages = (systemPrompt !== undefined && userMessage !== undefined)
    ? [
        { role: 'system', content: String(systemPrompt) },
        { role: 'user', content: String(userMessage).slice(0, MAX_INPUT_CHARS) },
      ]
    : [{ role: 'user', content: String(prompt ?? '').slice(0, MAX_INPUT_CHARS) }]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        keep_alive: keepAlive,
        options: { num_predict: numPredict },
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (res.status !== 200) {
      log(`Ollama chat HTTP ${res.status}: ${text.slice(0, 200)}`)
      return { ok: false, error: `Ollama chat HTTP ${res.status}` }
    }
    let parsed
    try { parsed = JSON.parse(text) } catch {
      log('réponse Ollama non-JSON')
      return { ok: false, error: 'réponse Ollama non-JSON' }
    }
    const reply = String(parsed?.message?.content ?? '').trim()
    if (!reply) {
      return { ok: false, error: 'réponse vide du cerveau' }
    }
    return { ok: true, reply: reply.slice(0, MAX_REPLY_CHARS) }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'timeout cerveau' }
    log(`ollama-brain fetch échoué: ${err.message}`)
    return { ok: false, error: 'fetch Ollama échoué' }
  } finally {
    clearTimeout(timer)
  }
}
