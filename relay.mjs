import { loadDotEnv } from './src/env.mjs'
import { buildPrompt, invokeBrain } from './src/brain.mjs'
import { invokeBrainIAQ } from './src/iaq-brain.mjs'
import { postReply, deriveAddress } from './src/cbor-client.mjs'
import { createRelayServer } from './src/server.mjs'

const env = { ...loadDotEnv(new URL('.env', import.meta.url).pathname), ...process.env }
const required = ['MESGIA_API', 'MESGIA_WALLET_KEY', 'MESGIA_WEBHOOK_SECRET']
const missing = required.filter((k) => !env[k])
if (missing.length) {
  console.error(`Variables manquantes dans .env : ${missing.join(', ')}`)
  process.exit(1)
}

// Cerveau : "cli" (kimi -p, défaut) ou "iaq" (IAQ Router sur ia-general).
const brainMode = env.BRAIN_MODE ?? 'cli'
if (!['cli', 'iaq'].includes(brainMode)) {
  console.error(`BRAIN_MODE invalide : ${brainMode} (attendu "cli" ou "iaq")`)
  process.exit(1)
}

function parseTimeoutMs(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const log = (msg) => console.error(`${new Date().toISOString()} ${msg}`)

let brain
if (brainMode === 'iaq') {
  const iaqMissing = ['IAQ_TOKEN'].filter((k) => !env[k])
  if (iaqMissing.length) {
    console.error(`Mode iaq : variables manquantes dans .env : ${iaqMissing.join(', ')}`)
    process.exit(1)
  }
  brain = async (message) => invokeBrainIAQ({
    prompt: buildPrompt(message),
    apiUrl: env.IAQ_API_URL || 'http://10.0.0.223:8001',
    token: env.IAQ_TOKEN,
    model: env.IAQ_MODEL || 'qwen35-9b',
    timeoutMs: parseTimeoutMs(env.BRAIN_TIMEOUT_MS, 180_000),
    log,
  })
} else {
  brain = async (message) => invokeBrain(buildPrompt(message), {
    bin: env.BRAIN_BIN || undefined,
    timeoutMs: parseTimeoutMs(env.BRAIN_TIMEOUT_MS, 120_000),
  })
}

// Wallet Ethereum du relais (identité M2M) : la clé privée vit en .env (chmod 600),
// elle n'est jamais journalisée ici.
const walletAddress = deriveAddress(env.MESGIA_WALLET_KEY)

const server = createRelayServer({
  secret: env.MESGIA_WEBHOOK_SECRET,
  brain,
  postReply: ({ conversationId, message }) => postReply({
    api: env.MESGIA_API,
    wallet: walletAddress,
    privateKey: env.MESGIA_WALLET_KEY,
    conversationId, message,
  }),
  log,
})

const port = Number(env.RELAY_PORT ?? 8787)
server.listen(port, '127.0.0.1', () => console.error(`mesgia-relay en écoute sur 127.0.0.1:${port}`))
