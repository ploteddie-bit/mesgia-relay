import { loadDotEnv } from './src/env.mjs'
import { buildPrompt, invokeBrain } from './src/brain.mjs'
import { postReply } from './src/mesgia-client.mjs'
import { createRelayServer } from './src/server.mjs'

const env = { ...loadDotEnv(new URL('.env', import.meta.url).pathname), ...process.env }
const required = ['MESGIA_API', 'MESGIA_AGENT_ID', 'MESGIA_AGENT_KEY', 'MESGIA_WEBHOOK_SECRET']
const missing = required.filter((k) => !env[k])
if (missing.length) {
  console.error(`Variables manquantes dans .env : ${missing.join(', ')}`)
  process.exit(1)
}

const server = createRelayServer({
  secret: env.MESGIA_WEBHOOK_SECRET,
  brain: async (message) => invokeBrain(buildPrompt(message), {
    bin: env.BRAIN_BIN || undefined,
    timeoutMs: Number(env.BRAIN_TIMEOUT_MS ?? 120_000),
  }),
  postReply: ({ conversationId, message }) => postReply({
    apiUrl: env.MESGIA_API, agentId: env.MESGIA_AGENT_ID, apiKey: env.MESGIA_AGENT_KEY,
    conversationId, message,
  }),
  log: (msg) => console.error(`${new Date().toISOString()} ${msg}`),
})

const port = Number(env.RELAY_PORT ?? 8787)
server.listen(port, '127.0.0.1', () => console.error(`mesgia-relay en écoute sur 127.0.0.1:${port}`))
