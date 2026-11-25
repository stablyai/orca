import { describe, expect, it, vi } from 'vitest'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import '../../../../../../shared/terminal/input/terminal-input'
import '../../../../../../shared/clipboard/clipboard-text'
import {
  createDeferred,
  flushAsyncTicks
} from '../../pty-connection/test-fixtures/pty-connection-test-async'

type WriteRecord = { id: string; data: string }

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
})
