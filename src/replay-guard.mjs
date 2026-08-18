import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000

/**
 * Garde anti-rejeu des webhooks HMAC.
 *
 * Mémorise les clés déjà vues pendant `ttlMs` (défaut 10 min). La persistance
 * est optionnelle : si `filePath` est fourni, les clés sont chargées au premier
 * usage et ré-écrites de façon atomique (fichier temporaire + rename) à chaque
 * enregistrement. Une purge opportuniste retire les entrées expirées.
 *
 * @param {{ filePath?: string, ttlMs?: number, now?: () => number, onError?: (err: Error) => void }} opts
 * @returns {{ checkAndRecord: (key: string) => boolean }}
 */
export function createReplayGuard({ filePath, ttlMs = DEFAULT_REPLAY_TTL_MS, now = Date.now, onError = () => {} } = {}) {
  const seen = new Map() // key -> expiresAt (epoch ms)
  let loaded = false

  function purge(nowMs) {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= nowMs) seen.delete(key)
    }
  }

  function load() {
    if (loaded) return
    loaded = true
    if (!filePath) return
    try {
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'))
        const entries = Array.isArray(data?.entries) ? data.entries : []
        const nowMs = now()
        for (const e of entries) {
          if (e && typeof e.k === 'string' && typeof e.expiresAt === 'number' && e.expiresAt > nowMs) {
            seen.set(e.k, e.expiresAt)
          }
        }
      }
    } catch (err) {
      // Fichier corrompu ou illisible : on repart d'une mémoire vide sans bloquer le relais.
      onError(err)
    }
  }

  function persist() {
    if (!filePath) return
    try {
      const nowMs = now()
      const entries = []
      for (const [k, expiresAt] of seen) {
        if (expiresAt > nowMs) entries.push({ k, expiresAt })
      }
      const tmp = `${filePath}.tmp`
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ entries }))
      renameSync(tmp, filePath)
    } catch (err) {
      // Une écriture en échec ne doit pas faire tomber le relais.
      onError(err)
    }
  }

  /**
   * Vérifie et enregistre la clé en une seule étape (atomique en mémoire).
   * @returns {boolean} true si la clé a déjà été vue (rejeu), false sinon.
   */
  function checkAndRecord(key) {
    load()
    const nowMs = now()
    purge(nowMs)
    const existing = seen.get(key)
    if (existing !== undefined && existing > nowMs) return true
    seen.set(key, nowMs + ttlMs)
    persist()
    return false
  }

  return { checkAndRecord }
}
