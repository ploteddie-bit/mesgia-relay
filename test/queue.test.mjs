import test from 'node:test'
import assert from 'node:assert/strict'
import { createFifo } from '../src/queue.mjs'

test('fifo : ordre de traitement séquentiel', async () => {
  const events = []
  const fifo = createFifo(async (n) => {
    events.push(`start-${n}`)
    await new Promise((r) => setTimeout(r, 20))
    events.push(`end-${n}`)
  })
  fifo(1); fifo(2); fifo(3)
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3'])
})

test('fifo : une erreur n interrompt pas la file', async () => {
  const events = []
  const fifo = createFifo(async (n) => {
    if (n === 1) throw new Error('boum')
    events.push(n)
  })
  fifo(1); fifo(2)
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(events, [2])
})
