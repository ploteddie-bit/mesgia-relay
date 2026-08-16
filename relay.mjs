import { loadDotEnv } from './src/env.mjs'
import { buildPrompt, invokeBrain } from './src/brain.mjs'
import { postReply, deriveAddress } from './src/cbor-client.mjs'
import { createRelayServer } from './src/server.mjs'

const env = { ...loadDotEnv(new URL('.env', import.meta.url).pathname), ...process.env }
const required = ['MESGIA_API', 'MESGIA_WALLET_KEY', 'MESGIA_WEBHOOK_SECRET']
const missing = required.filter((k) => !env[k])
if (missing.length) {
  console.error(`Variables manquantes dans .env : ${missing.join(', ')}`)
  process.exit(1)
}

// Wallet Ethereum du relais (identité M2M) : la clé privée vit en .env (chmod 600),
// elle n'est jamais journalisée ici.
const walletAddress = deriveAddress(env.MESGIA_WALLET_KEY)

const server = createRelayServer({
  secret: env.MESGIA_WEBHOOK_SECRET,
  brain: async (message) => invokeBrain(buildPrompt(message), {
    bin: env.BRAIN_BIN || undefined,
    timeoutMs: Number(env.BRAIN_TIMEOUT_MS ?? 120_000),
  }),
  postReply: ({ conversationId, message }) => postReply({
    api: env.MESGIA_API,
    wallet: walletAddress,
    privateKey: env.MESGIA_WALLET_KEY,
    conversationId, message,
  }),
  log: (msg) => console.error(`${new Date().toISOString()} ${msg}`),
})

const port = Number(env.RELAY_PORT ?? 8787)
server.listen(port, '127.0.0.1', () => console.error(`mesgia-relay en écoute sur 127.0.0.1:${port}`))
