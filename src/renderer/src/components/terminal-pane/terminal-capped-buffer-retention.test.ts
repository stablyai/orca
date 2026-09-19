import { describe, expect, it } from 'vitest'
import { capTerminalScrollbackSessionBuffer } from '../../../../shared/workspace-session-terminal-buffers'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import { clampUtf8Tail } from './pty-eager-buffer-clamp'
import { PtyShutdownOutputQueue } from './pty-shutdown-output-queue'
import { DeferredReattachLiveDataQueue } from './deferred-reattach-live-data-queue'
import { appendPaneTerminalError, type TerminalErrorsByPaneId } from './terminal-error-accumulation'

const LIMIT = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
const PARENT_CHARS = 4 * 1024 * 1024
const COUNT = 8

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

function createPaneErrors(): TerminalErrorsByPaneId {
  let errors: TerminalErrorsByPaneId = {}
  for (let index = 0; index < COUNT; index++) {
    errors = appendPaneTerminalError(errors, 0, `${'x'.repeat(PARENT_CHARS)}:${index}`)
  }
  return errors
}

describe('capped terminal buffer retention', () => {
  it.each([
    ['persisted scrollback', capTerminalScrollbackSessionBuffer],
    ['eager/pre-handler output', (text: string) => clampUtf8Tail(text, LIMIT).data]
  ] as const)('detaches %s from oversized incoming strings', (_label, cap) => {
    const before = heapAfterGc()
    const retained = Array.from({ length: COUNT }, (_value, index) =>
      cap(`${index}:${'x'.repeat(PARENT_CHARS)}`)
    )
    const growth = heapAfterGc() - before

    expect(retained.every((text) => text === 'x'.repeat(LIMIT))).toBe(true)
    expect(growth).toBeLessThan(COUNT * LIMIT * 2)
  })

  it('keeps shutdown queue heap storage near its byte ledger after clamping', () => {
    const before = heapAfterGc()
    const queues = Array.from({ length: COUNT }, (_value, index) => {
      const queue = new PtyShutdownOutputQueue()
      queue.enqueue({ kind: 'replay', data: `${index}:${'x'.repeat(PARENT_CHARS)}` })
      return queue
    })
    const growth = heapAfterGc() - before

    expect(queues.every((queue) => queue.getStorageForTest().retainedBytes === LIMIT)).toBe(true)
    expect(growth).toBeLessThan(COUNT * LIMIT * 2)
    for (const queue of queues) {
      expect(queue.takeAll()).toEqual([{ kind: 'replay', data: 'x'.repeat(LIMIT) }])
    }
  })

  it('detaches oversized chunks while a reattach queue waits for its consumer', () => {
    const before = heapAfterGc()
    const queues = Array.from({ length: COUNT }, (_value, index) => {
      const queue = new DeferredReattachLiveDataQueue()
      queue.enqueue({
        data: `${index}:${'x'.repeat(PARENT_CHARS)}`,
        ptyId: 'p',
        streamGeneration: 1
      })
      return queue
    })
    const growth = heapAfterGc() - before

    expect(queues.every((queue) => queue.getStorageForTest().retainedChars === LIMIT)).toBe(true)
    expect(growth).toBeLessThan(COUNT * LIMIT * 2)
    for (const queue of queues) {
      expect(queue.takeAll()[0]?.data).toBe('x'.repeat(LIMIT))
    }
  })

  it('keeps capped pane errors without retaining the original error payloads', () => {
    const before = heapAfterGc()
    const errors = createPaneErrors()
    const growth = heapAfterGc() - before

    expect(errors[0]).toHaveLength(COUNT)
    expect(
      errors[0].every((text, index) => text.length === 4000 && text.endsWith(`:${index}`))
    ).toBe(true)
    expect(growth).toBeLessThan(PARENT_CHARS)
  })
})
