import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stream-ok.jsonl')
process.stdout.write(readFileSync(fixture, 'utf8'))
