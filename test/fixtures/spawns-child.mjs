import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// Fixture pour M1 : spawne un enfant de longue durée, écrit son PID dans le
// fichier passé en argument, puis reste en vie. Au timeout, invokeBrain doit
// tuer tout le GROUPE de process (fixture + enfant), pas seulement le child direct.
const pidFile = process.argv[2]
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
writeFileSync(pidFile, String(grandchild.pid))
setTimeout(() => {}, 30000)
