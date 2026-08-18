import { MAX_INPUT_CHARS } from './brain.mjs'

/**
 * Cerveau IAQ Router (alternative phase 1.5).
 *
 * Soumet une inférence au routeur IAQ (ia-general, http://10.0.0.223:8001),
 * poll la tâche jusqu'à completed, puis récupère l'artifact result.html.
 *
 * Contrat vérifié le 2026-08-18 (tâche 4b1f6ddf-50f0-4446-84ec-578f4fee7cc0) :
 *  - POST /submit  {type:"inference", origin, priority:"medium", model, payload:{messages}} → 201 {id}
 *  - GET  /task/{id}  → {status: queued|running|completed|failed, error?}
 *  - GET  /task/{id}/artifact/result.html → {content, encoding:"text"} — purge ~20 min
 *
 * Règles : JAMAIS de log du token ni du header Authorization ; le détail des
 * erreurs HTTP part dans `log`, le message retourné reste générique (il peut
 * transiter vers le fallback posté sur Mesgia — pas de fuite d'infos internes) ;
 * chaque fetch a un AbortSignal borné par la deadline globale ; la réponse est
 * bornée à MAX_REPLY_CHARS (limite dure Mesgia).
 */

export const IAQ_DEFAULT_TIMEOUT_MS = 180_000 // latence réelle observée ~90 s (qwen35-9b, chargement inclus)
export const IAQ_POLL_INTERVAL_MS = 1_500
export const MAX_REPLY_CHARS = 5000
export const IAQ_ORIGIN = 'mesgia-relay'
export const IAQ_PRIORITY = 'medium'

// Marge accordée à la récupération de l'artifact une fois la tâche `completed` :
// le résultat existe déjà, on ne le perd pas si la deadline globale est quasi atteinte.
const ARTIFACT_MIN_GRACE_MS = 5_000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Temps restant avant la deadline globale (>= 0). */
function remainingTimeout(deadline) {
  return Math.max(0, deadline - Date.now())
}

async function fetchWithDeadline(url, { deadline, ...opts }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remainingTimeout(deadline))
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Erreur HTTP : le détail (corps, 200 chars) part au log, le message reste générique. */
function httpError(label, status, body, log) {
  const detail = typeof body === 'string' ? body.slice(0, 200) : String(body ?? '')
  log(`${label} HTTP ${status}: ${detail}`)
  return new Error(`${label} HTTP ${status}`)
}

async function submit({ messages, apiUrl, token, model, deadline, log }) {
  const body = JSON.stringify({
    type: 'inference',
    origin: IAQ_ORIGIN,
    priority: IAQ_PRIORITY,
    model,
    payload: { messages },
  })
  let res
  try {
    res = await fetchWithDeadline(`${apiUrl.replace(/\/+$/, '')}/submit`, {
      deadline,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timeout cerveau')
    log(`fetch submit échoué: ${err.message}`)
    throw new Error('fetch submit échoué')
  }
  const text = await res.text()
  if (res.status !== 201) {
    throw httpError('IAQ submit', res.status, text, log)
  }
  let parsed
  try { parsed = JSON.parse(text) } catch {
    log('réponse submit IAQ non-JSON')
    throw new Error('réponse submit IAQ non-JSON')
  }
  if (!parsed || typeof parsed.id !== 'string') {
    log('réponse submit IAQ sans id')
    throw new Error('réponse submit IAQ sans id')
  }
  return parsed.id
}

async function pollTask(taskId, { apiUrl, token, deadline, log }) {
  let res
  try {
    res = await fetchWithDeadline(`${apiUrl.replace(/\/+$/, '')}/task/${taskId}`, {
      deadline,
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timeout cerveau')
    log(`fetch task échoué: ${err.message}`)
    throw new Error('fetch task échoué')
  }
  if (res.status !== 200) {
    throw httpError('IAQ task', res.status, await res.text(), log)
  }
  let t
  try { t = await res.json() } catch {
    log(`IAQ task ${taskId} : réponse non-JSON`)
    throw new Error('réponse task IAQ non-JSON')
  }
  return { status: t?.status ?? 'unknown', error: t?.error ?? null }
}

async function fetchArtifact(taskId, { apiUrl, token, deadline, log }) {
  let res
  try {
    res = await fetchWithDeadline(`${apiUrl.replace(/\/+$/, '')}/task/${taskId}/artifact/result.html`, {
      deadline,
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timeout cerveau')
    log(`fetch artifact échoué: ${err.message}`)
    throw new Error('fetch artifact échoué')
  }
  if (res.status !== 200) {
    throw httpError('IAQ artifact', res.status, await res.text(), log)
  }
  let a
  try { a = await res.json() } catch {
    log(`IAQ artifact ${taskId} : réponse non-JSON`)
    throw new Error('réponse artifact IAQ non-JSON')
  }
  return a?.content ?? ''
}

/**
 * @param {{ prompt?: string, systemPrompt?: string, userMessage?: string,
 *           apiUrl: string, token: string, model: string,
 *           timeoutMs?: number, log?: (msg: string) => void }} args
 * @returns {Promise<{ok: true, reply: string} | {ok: false, error: string}>}
 */
export async function invokeBrainIAQ({ prompt, systemPrompt, userMessage, apiUrl, token, model, timeoutMs = IAQ_DEFAULT_TIMEOUT_MS, log = () => {} }) {
  // Anti-injection (P1-2) : les consignes relais partent en rôle system, le contenu
  // utilisateur en rôle user. La rétrocompat `prompt` (un seul message user) est
  // conservée pour les appels existants et les tests.
  const messages = (systemPrompt !== undefined && userMessage !== undefined)
    ? [
        { role: 'system', content: String(systemPrompt) },
        { role: 'user', content: String(userMessage).slice(0, MAX_INPUT_CHARS) },
      ]
    : [{ role: 'user', content: prompt }]

  const deadline = Date.now() + timeoutMs
  try {
    const taskId = await submit({ messages, apiUrl, token, model, deadline, log })

    let status = null
    while (Date.now() < deadline) {
      const t = await pollTask(taskId, { apiUrl, token, deadline, log })
      status = t.status
      if (status === 'completed') break
      if (status === 'failed') {
        log(`tâche IAQ ${taskId} failed: ${t.error ?? 'erreur inconnue'}`)
        return { ok: false, error: 'tâche IAQ failed' }
      }
      await sleep(Math.min(IAQ_POLL_INTERVAL_MS, remainingTimeout(deadline)))
    }
    if (status !== 'completed') {
      return { ok: false, error: 'timeout cerveau' }
    }

    // La tâche est complétée : on accorde une marge minimale pour récupérer l'artifact.
    const artifactDeadline = Math.max(deadline, Date.now() + ARTIFACT_MIN_GRACE_MS)
    const content = await fetchArtifact(taskId, { apiUrl, token, deadline: artifactDeadline, log })
    const reply = String(content ?? '').trim()
    if (!reply) {
      return { ok: false, error: 'réponse vide du cerveau' }
    }
    return { ok: true, reply: reply.slice(0, MAX_REPLY_CHARS) }
  } catch (err) {
    // Le message est déjà générique ; on ne loggue jamais le token ici.
    log(`iaq-brain: ${err?.message ?? 'erreur IAQ inconnue'}`)
    return { ok: false, error: err?.message ?? 'erreur IAQ inconnue' }
  }
}
