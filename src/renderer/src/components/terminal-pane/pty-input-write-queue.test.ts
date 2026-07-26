import { describe, expect, it } from 'vitest'
import {
  TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS,
  createPtyInputWriteQueue
} from './pty-input-write-queue'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'

const WHEEL_UP_REPORT = '\x1b[<64;60;20M'

type WriteRecord = { id: string; data: string }

function createRecordingQueue(options: { writable?: () => boolean } = {}): {
  writes: WriteRecord[]
  queue: ReturnType<typeof createPtyInputWriteQueue>
} {
  const writes: WriteRecord[] = []
  const queue = createPtyInputWriteQueue({
    isWritable: () => options.writable?.() ?? true,
    write: (id, data) => writes.push({ id, data })
  })
  return { writes, queue }
}

describe('pty input write queue', () => {
  it('coalesces a dense burst of wheel reports instead of one write per macrotask turn', async () => {
    const { writes, queue } = createRecordingQueue()

    // Simulates a 2s aggressive trackpad gesture at 120Hz: 240 SGR reports
    // enqueued while the drain cannot run between events.
    for (let i = 0; i < 240; i += 1) {
      expect(queue.enqueue('pty-1', WHEEL_UP_REPORT)).toBe(true)
    }
    await queue.waitForDrain()

    // First report flushes immediately (keystroke latency); everything queued
    // behind it must drain as a single coalesced write, not 239 timer turns.
    expect(writes.length).toBe(2)
    expect(writes[0]?.data).toBe(WHEEL_UP_REPORT)
    expect(writes[1]?.data).toBe(WHEEL_UP_REPORT.repeat(239))
    expect(writes.map((write) => write.id)).toEqual(['pty-1', 'pty-1'])
  })

  it('preserves byte order and content across coalesced writes', async () => {
    const { writes, queue } = createRecordingQueue()

    const inputs = ['a', '\x1b[<65;1;1M', 'bc', '\x1b[A', 'd']
    for (const input of inputs) {
      queue.enqueue('pty-1', input)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toBe(inputs.join(''))
  })

  it('does not coalesce across different PTY ids', async () => {
    const writes: WriteRecord[] = []
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => writes.push({ id, data })
    })

    queue.enqueue('pty-1', 'a')
    queue.enqueue('pty-1', 'b')
    queue.enqueue('pty-2', 'c')
    queue.enqueue('pty-1', 'd')
    await queue.waitForDrain()

    expect(writes).toEqual([
      { id: 'pty-1', data: 'a' },
      { id: 'pty-1', data: 'b' },
      { id: 'pty-2', data: 'c' },
      { id: 'pty-1', data: 'd' }
    ])
  })

  it('keeps coalesced payloads under the input chunk byte cap', async () => {
    const { writes, queue } = createRecordingQueue()

    const piece = 'x'.repeat(1000)
    for (let i = 0; i < 12; i += 1) {
      queue.enqueue('pty-1', piece)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toBe(piece.repeat(12))
    for (const write of writes) {
      expect(write.data.length).toBeLessThanOrEqual(TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS)
    }
    expect(writes.length).toBeGreaterThan(1)
  })

  it('still chunks oversized items and keeps trailing input ordered behind them', async () => {
    const { writes, queue } = createRecordingQueue()

    const large = 'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 100)
    queue.enqueue('pty-1', 'before')
    queue.enqueue('pty-1', large)
    queue.enqueue('pty-1', 'after')
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toBe(`before${large}after`)
    expect(writes.at(-1)?.data).toBe('after')
    for (const write of writes) {
      expect(write.data.length).toBeLessThanOrEqual(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    }
  })

  it('rejects input over the terminal input byte limit without writing', async () => {
    const { writes, queue } = createRecordingQueue()

    expect(queue.enqueue('pty-1', 'z'.repeat(TERMINAL_INPUT_MAX_BYTES + 1))).toBe(false)
    await queue.waitForDrain()

    expect(writes).toEqual([])
  })

  it('drops queued input for PTYs that are no longer writable', async () => {
    let writable = true
    const { writes, queue } = createRecordingQueue({ writable: () => writable })

    queue.enqueue('pty-1', 'a')
    writable = false
    queue.enqueue('pty-1', 'b')
    await queue.waitForDrain()

    expect(writes).toEqual([{ id: 'pty-1', data: 'a' }])
  })

  it('clear() drops pending input that has not been written yet', async () => {
    const writes: WriteRecord[] = []
    const pendingYields: (() => void)[] = []
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => writes.push({ id, data }),
      yieldBetweenWrites: () =>
        new Promise<void>((resolve) => {
          pendingYields.push(resolve)
        })
    })

    const large = 'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 3)
    queue.enqueue('pty-1', large)
    queue.enqueue('pty-1', 'tail')
    // First chunk is written synchronously, then the drain parks on the yield.
    expect(writes.length).toBe(1)

    queue.clear()
    pendingYields.shift()?.()
    await queue.waitForDrain()

    expect(writes.length).toBe(1)
    expect(writes.map((write) => write.data).join('')).not.toContain('tail')
  })

  it('rejects producer backlog beyond the retained item and text budgets', async () => {
    const writes: WriteRecord[] = []
    const pendingYields: (() => void)[] = []
    const large = 'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2)
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => writes.push({ id, data }),
      yieldBetweenWrites: () =>
        new Promise<void>((resolve) => {
          pendingYields.push(resolve)
        }),
      maxPendingItems: 2,
      maxPendingCodeUnits: large.length + 4
    })

    expect(queue.enqueue('pty-1', large)).toBe(true)
    expect(queue.enqueue('pty-1', 'tail')).toBe(true)
    expect(queue.enqueue('pty-1', '!')).toBe(false)

    queue.clear()
    pendingYields.shift()?.()
    await queue.waitForDrain()

    expect(writes).toEqual([{ id: 'pty-1', data: large.slice(0, TERMINAL_INPUT_CHUNK_MAX_BYTES) }])
  })

  it('does not write deferred input after clear', async () => {
    const { writes, queue } = createRecordingQueue()
    const deferred = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    expect(queue.enqueue('pty-1', deferred)).toBe(true)
    queue.clear()
    await queue.waitForDrain()

    expect(writes).toEqual([])
  })
})
