import { describe, expect, it } from 'vitest'
import { createIncrementalNdjsonFramer } from './main-process-ndjson-framer'

const CHUNK_CHARS = 1024 * 1024
const READERS = 32
const TAIL = 'tail'.repeat(1024)

function collectHeap(): number {
  if (!globalThis.gc) {
    throw new Error('Run this regression with --expose-gc')
  }
  // V8's last regexp input is a separate owner of the record under test.
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

describe('NDJSON retained chunk memory', () => {
  it.each(['tail', 'paused', 'rejected'] as const)(
    'releases consumed megabyte records while retaining %s content exactly',
    (mode) => {
      const held: { finish: () => void; result: () => string }[] = []
      const baseline = collectHeap()
      for (let index = 0; index < READERS; index += 1) {
        let paused = false
        let result = ''
        const framer = createIncrementalNdjsonFramer(
          (record) => {
            if (record && typeof record === 'object' && 'tail' in record) {
              result = typeof record.tail === 'string' ? record.tail : ''
            }
            if (mode === 'paused') {
              paused = true
            }
          },
          (rejected) => {
            if (rejected.kind === 'line-too-long') {
              result = rejected.prefix
            }
          },
          {
            maxLineBytes: mode === 'rejected' ? 1024 : CHUNK_CHARS * 2,
            shouldPause: () => paused
          }
        )
        const payload = String.fromCharCode(65 + (index % 26)).repeat(CHUNK_CHARS)
        const chunk = `{"data":"${payload}"}\n${mode === 'paused' ? '{}\n' : ''}${mode === 'rejected' ? '' : `{"tail":"${TAIL}`}`
        framer.feed(chunk)
        held.push({
          finish: () => {
            if (mode === 'paused') {
              paused = false
              framer.resume()
              // Delivering the queued record pauses again before the unfinished tail.
              paused = false
              framer.resume()
            }
            if (mode !== 'rejected') {
              framer.feed('"}\n')
            }
          },
          result: () => result
        })
      }
      const retainedBytes = collectHeap() - baseline
      expect(held).toHaveLength(READERS)
      expect(retainedBytes).toBeLessThan(8 * 1024 * 1024)
      for (const reader of held) {
        reader.finish()
        if (mode === 'rejected') {
          expect(reader.result()).toHaveLength(64 * 1024)
          expect(reader.result().startsWith('{"data":"')).toBe(true)
        } else {
          expect(reader.result()).toBe(TAIL)
        }
      }
    }
  )
})
