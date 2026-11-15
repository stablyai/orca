import { describe, expect, it, vi } from 'vitest'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../../../shared/terminal/input/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../../../shared/clipboard-text'
import {
  createDeferred,
  flushAsyncTicks
} from '../../pty-connection/test-fixtures/pty-connection-test-async'

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
  it('contains drain failures and rejects input until queue reuse', async () => {
    const failure = new Error('write failed')
    const writes: WriteRecord[] = []
    let shouldThrow = true
    const onDrainFailure = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => {
        if (shouldThrow) {
          throw failure
        }
        writes.push({ id, data })
      },
      onDrainFailure
    })

    try {
      expect(queue.enqueue('pty-1', 'stale', 'driving')).toBe(true)
      expect(queue.enqueue('pty-1', 'also-stale', 'driving')).toBe(false)
      await expect(queue.waitForDrain()).resolves.toBeUndefined()

      shouldThrow = false
      expect(queue.enqueue('pty-1', 'still-stale', 'driving')).toBe(false)
      queue.clear()
      expect(queue.enqueue('pty-1', 'fresh', 'driving')).toBe(true)
      await queue.waitForDrain()

      expect(writes).toEqual([{ id: 'pty-1', data: 'fresh' }])
      expect(warn).toHaveBeenCalledWith('[pty-input-write-queue] drain failed:', failure)
      expect(onDrainFailure).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('serializes accepted input at its invocation position', async () => {
    const acceptedWrite = createDeferred<boolean>()
    const delivered: string[] = []
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (_id, data) => delivered.push(`ordinary:${data}`),
      writeAccepted: async (_id, data) => {
        delivered.push(`accepted:${data}`)
        return acceptedWrite.promise
      }
    })

    expect(queue.enqueue('pty-1', 'first', 'driving')).toBe(true)
    const accepted = queue.enqueueAccepted('pty-1', 'second', 'driving')
    expect(queue.enqueue('pty-1', 'third', 'driving')).toBe(true)
    expect(queue.enqueueQueryReply('pty-1', 'fourth')).toBe(true)
    await flushAsyncTicks()

    expect(delivered).toEqual(['ordinary:first', 'accepted:second'])

    acceptedWrite.resolve(true)
    await expect(accepted).resolves.toBe(true)
    await queue.waitForDrain()

    expect(delivered).toEqual([
      'ordinary:first',
      'accepted:second',
      'ordinary:third',
      'ordinary:fourth'
    ])
  })

  it('reserves one drain before an accepted write enqueues reentrantly', async () => {
    const acceptedWrite = createDeferred<boolean>()
    const delivered: string[] = []
    let reentered = false
    let queue!: ReturnType<typeof createPtyInputWriteQueue>
    queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (_id, data) => delivered.push(`ordinary:${data}`),
      writeAccepted: async (_id, data) => {
        delivered.push(`accepted:${data}`)
        if (!reentered) {
          reentered = true
          queue.enqueue('pty-1', 'later', 'driving')
        }
        return acceptedWrite.promise
      }
    })

    const accepted = queue.enqueueAccepted('pty-1', 'first', 'driving')
    await flushAsyncTicks()

    expect(delivered).toEqual(['accepted:first'])

    acceptedWrite.resolve(true)
    await expect(accepted).resolves.toBe(true)
    await queue.waitForDrain()

    expect(delivered).toEqual(['accepted:first', 'ordinary:later'])
  })

  it('keeps draining fresh input when an accepted write clears reentrantly', async () => {
    const acceptedWrite = createDeferred<boolean>()
    const delivered: string[] = []
    let queue!: ReturnType<typeof createPtyInputWriteQueue>
    queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (_id, data) => delivered.push(`ordinary:${data}`),
      writeAccepted: (_id, data) => {
        delivered.push(`accepted:${data}`)
        queue.clear()
        queue.enqueue('pty-1', 'fresh', 'driving')
        return acceptedWrite.promise
      }
    })

    const accepted = queue.enqueueAccepted('pty-1', 'stale', 'driving')

    await expect(accepted).resolves.toBe(false)
    await queue.waitForDrain()
    expect(delivered).toEqual(['accepted:stale', 'ordinary:fresh'])

    acceptedWrite.resolve(true)
    await flushAsyncTicks()

    expect(delivered).toEqual(['accepted:stale', 'ordinary:fresh'])
  })

  it('clear settles active and pending accepted input before same-id queue reuse', async () => {
    const acceptedWrite = createDeferred<boolean>()
    const acceptedStarted = createDeferred<void>()
    const delivered: string[] = []
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (_id, data) => delivered.push(`ordinary:${data}`),
      writeAccepted: async (_id, data) => {
        delivered.push(`accepted:${data}`)
        acceptedStarted.resolve()
        return acceptedWrite.promise
      }
    })
    const active = queue.enqueueAccepted('pty-1', 'stale-active', 'driving')
    const pending = queue.enqueueAccepted('pty-1', 'stale-pending', 'driving')
    await acceptedStarted.promise

    queue.clear()
    expect(queue.enqueue('pty-1', 'fresh', 'driving')).toBe(true)

    await expect(active).resolves.toBe(false)
    await expect(pending).resolves.toBe(false)
    await queue.waitForDrain()
    expect(delivered).toEqual(['accepted:stale-active', 'ordinary:fresh'])

    acceptedWrite.resolve(true)
    await flushAsyncTicks()

    expect(delivered).toEqual(['accepted:stale-active', 'ordinary:fresh'])
  })

  it('does not let a stale drain failure clear input queued after reuse', async () => {
    const failure = new Error('stale yield failed')
    const writes: WriteRecord[] = []
    let rejectYield: ((error: Error) => void) | undefined
    let rejectNextYield = true
    const onDrainFailure = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => writes.push({ id, data }),
      yieldBetweenWrites: () => {
        if (!rejectNextYield) {
          return Promise.resolve()
        }
        return new Promise<void>((_resolve, reject) => {
          rejectYield = reject
        })
      },
      onDrainFailure
    })

    try {
      expect(
        queue.enqueue('pty-1', 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2), 'driving')
      ).toBe(true)
      expect(rejectYield).toBeDefined()
      queue.clear()
      rejectNextYield = false
      expect(queue.enqueue('pty-2', 'fresh', 'driving')).toBe(true)
      rejectYield?.(failure)
      await queue.waitForDrain()

      expect(writes.at(-1)).toEqual({ id: 'pty-2', data: 'fresh' })
      expect(warn).toHaveBeenCalledWith('[pty-input-write-queue] drain failed:', failure)
      expect(onDrainFailure).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('clear() fences an in-flight validation before queue reuse', async () => {
    vi.useFakeTimers()
    const { writes, queue } = createRecordingQueue()
    const stale = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    try {
      expect(queue.enqueue('pty-1', stale, 'driving')).toBe(true)
      queue.clear()
      expect(queue.enqueue('pty-1', 'fresh', 'driving')).toBe(true)

      await vi.runAllTimersAsync()
      await queue.waitForDrain()

      expect(writes).toEqual([{ id: 'pty-1', data: 'fresh' }])
    } finally {
      vi.useRealTimers()
    }
  })
})
