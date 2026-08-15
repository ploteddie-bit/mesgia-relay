export const MAX_MESSAGE_CHARS = 5000

/**
 * Poste la réponse du relais via l'API entrante Mesgia.
 * POST {apiUrl}/api/webhooks/{agentId} — Authorization: Bearer <apiKey>.
 */
export async function postReply({ apiUrl, agentId, apiKey, conversationId, message }) {
  const url = `${apiUrl.replace(/\/+$/, '')}/api/webhooks/${agentId}`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        message: String(message).slice(0, MAX_MESSAGE_CHARS),
      }),
    })
  } catch (err) {
    return { ok: false, error: `fetch échoué: ${err.message}` }
  }
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
  }
  let body = null
  try { body = JSON.parse(text) } catch { /* réponse non-JSON : acceptée */ }
  return { ok: true, status: res.status, body }
}
