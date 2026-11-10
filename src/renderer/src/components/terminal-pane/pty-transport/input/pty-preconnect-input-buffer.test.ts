import { describe, expect, it, vi } from 'vitest'
import {
  createDeferred,
  flushAsyncTicks
} from '../../pty-connection/test-fixtures/pty-connection-test-async'
import { createPtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'

describe('createPtyPreconnectInputBuffer', () => {
  it('shares one flush worker and preserves mixed input order', async () => {
    const acceptedWrite = createDeferred<boolean>()
    const buffer = createPtyPreconnectInputBuffer()
    const delivered: string[] = []
    const accepted = buffer.enqueueAccepted('first', 'driving')
    expect(buffer.enqueue('second', 'ordinary', 'driving')).toBe(true)
    expect(buffer.enqueue('third', 'immediate', 'driving')).toBe(true)
    const writer = {
      isCurrent: () => true,
      sendInput: (data: string) => {
        delivered.push(`ordinary:${data}`)
        return true
      },
      sendInputImmediate: (data: string) => {
        delivered.push(`immediate:${data}`)
        return true
      },
      sendInputAccepted: async (data: string) => {
        const result = await acceptedWrite.promise
        delivered.push(`accepted:${data}`)
        return result
      }
    }

    const firstFlush = buffer.flush(writer)
    const overlappingFlush = buffer.flush(writer)

    expect(overlappingFlush).toBe(firstFlush)
    await flushAsyncTicks()
    expect(delivered).toEqual([])

    acceptedWrite.resolve(true)
    await expect(accepted).resolves.toBe(true)
    await Promise.all([firstFlush, overlappingFlush])

    expect(delivered).toEqual(['accepted:first', 'ordinary:second', 'immediate:third'])
  })

  it.each(['resolve', 'reject'] as const)(
    'clear settles an in-flight accepted write before its late %s',
    async (lateOutcome) => {
      const acceptedWrite = createDeferred<boolean>()
      const writeStarted = createDeferred<void>()
      const buffer = createPtyPreconnectInputBuffer()
      const sendInput = vi.fn(() => true)
      const accepted = buffer.enqueueAccepted('first', 'driving')
      const laterAccepted = buffer.enqueueAccepted('third', 'driving')
      expect(buffer.enqueue('second', 'ordinary', 'driving')).toBe(true)
      const flushing = buffer.flush({
        isCurrent: () => true,
        sendInput,
        sendInputImmediate: () => true,
        sendInputAccepted: async () => {
          writeStarted.resolve()
          return acceptedWrite.promise
        }
      })
      await writeStarted.promise

      buffer.clear()

      await expect(accepted).resolves.toBe(false)
      await expect(laterAccepted).resolves.toBe(false)
      await expect(flushing).resolves.toBeUndefined()
      expect(sendInput).not.toHaveBeenCalled()
      expect(buffer.enqueue('after-clear', 'ordinary', 'driving')).toBe(false)

      if (lateOutcome === 'resolve') {
        acceptedWrite.resolve(true)
      } else {
        acceptedWrite.reject(new Error('late accepted write failure'))
      }
      await flushAsyncTicks()

      expect(sendInput).not.toHaveBeenCalled()
      await expect(accepted).resolves.toBe(false)
    }
  )

  it('places paste bytes ahead of keys typed while the clipboard is read', async () => {
    const buffer = createPtyPreconnectInputBuffer()
    const delivered: string[] = []
    const gate = buffer.openPasteGate()
    expect(gate).not.toBeNull()
    expect(buffer.hasPendingInput()).toBe(false)
    expect(buffer.enqueue('\r', 'ordinary', 'driving')).toBe(true)

    const flushing = buffer.flush(deliveringWriter(delivered))
    await flushAsyncTicks()
    expect(delivered).toEqual([])
    expect(buffer.isBuffering()).toBe(true)

    gate!.insertIncoming(() => {
      expect(buffer.enqueue('echo hi', 'ordinary', 'driving')).toBe(true)
    })
    gate!.close()
    await flushAsyncTicks()

    expect(delivered).toEqual(['echo hi', '\r'])
    expect(buffer.isBuffering()).toBe(false)
    await flushing
  })

  it('keeps that order when the paste closes before flush starts', async () => {
    const buffer = createPtyPreconnectInputBuffer()
    const delivered: string[] = []
    const gate = buffer.openPasteGate()
    expect(buffer.enqueue('\r', 'ordinary', 'driving')).toBe(true)
    gate!.insertIncoming(() => {
      buffer.enqueue('echo hi', 'ordinary', 'driving')
    })
    gate!.close()

    await buffer.flush(deliveringWriter(delivered))
    expect(delivered).toEqual(['echo hi', '\r'])
  })

  it('does not coalesce a recovery keystroke into the paste gate', async () => {
    const buffer = createPtyPreconnectInputBuffer([], { recoveryHold: true })
    const delivered: string[] = []
    const gate = buffer.openPasteGate()
    expect(buffer.enqueue('a', 'ordinary', 'driving')).toBe(true)
    expect(buffer.enqueue('b', 'ordinary', 'driving')).toBe(true)
    gate!.insertIncoming(() => {
      expect(buffer.enqueue('PASTE', 'ordinary', 'driving')).toBe(true)
    })
    gate!.close()

    await buffer.flush(deliveringWriter(delivered))
    expect(delivered).toEqual(['PASTE', 'ab'])
  })

  it('drops a parked paste gate on clear without delivering it', async () => {
    const buffer = createPtyPreconnectInputBuffer()
    const delivered: string[] = []
    const gate = buffer.openPasteGate()
    expect(buffer.enqueue('\r', 'ordinary', 'driving')).toBe(true)
    const flushing = buffer.flush(deliveringWriter(delivered))
    await flushAsyncTicks()

    buffer.clear()
    gate!.close()
    await flushAsyncTicks()

    expect(delivered).toEqual([])
    expect(buffer.isBuffering()).toBe(false)
    await flushing
  })
})

function deliveringWriter(delivered: string[]): {
  isCurrent: () => boolean
  sendInput: (data: string) => boolean
  sendInputImmediate: (data: string) => boolean
} {
  return {
    isCurrent: () => true,
    sendInput: (data) => {
      delivered.push(data)
      return true
    },
    sendInputImmediate: (data) => {
      delivered.push(data)
      return true
    }
  }
}
