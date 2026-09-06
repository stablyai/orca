import { describe, expect, it, vi } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createPtyPreconnectInputBuffer,
  PTY_PRECONNECT_INPUT_MAX_CODE_UNITS,
  PTY_PRECONNECT_INPUT_MAX_ENTRIES
} from './pty-preconnect-input-buffer'

describe('createPtyPreconnectInputBuffer', () => {
  it('shares one flush worker and preserves mixed input order', async () => {
    const acceptedWrite = createDeferred<boolean>()
    const buffer = createPtyPreconnectInputBuffer()
    const delivered: string[] = []
    const accepted = buffer.enqueueAccepted('first')
    expect(buffer.enqueue('second', 'ordinary')).toBe(true)
    expect(buffer.enqueue('third', 'immediate')).toBe(true)
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
      const accepted = buffer.enqueueAccepted('first')
      const laterAccepted = buffer.enqueueAccepted('third')
      expect(buffer.enqueue('second', 'ordinary')).toBe(true)
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
      expect(buffer.enqueue('after-clear', 'ordinary')).toBe(false)

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

  it('counts an in-flight accepted write toward both retention caps', async () => {
    const codeUnitWrite = createDeferred<boolean>()
    const codeUnitWriteStarted = createDeferred<void>()
    const codeUnitBuffer = createPtyPreconnectInputBuffer()
    const codeUnitAccepted = codeUnitBuffer.enqueueAccepted(
      'x'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS)
    )
    const codeUnitFlush = codeUnitBuffer.flush({
      isCurrent: () => true,
      sendInput: () => true,
      sendInputImmediate: () => true,
      sendInputAccepted: async () => {
        codeUnitWriteStarted.resolve()
        return codeUnitWrite.promise
      }
    })
    await codeUnitWriteStarted.promise

    expect(codeUnitBuffer.enqueue('overflow', 'ordinary')).toBe(false)

    codeUnitBuffer.clear()
    codeUnitWrite.resolve(true)
    await expect(codeUnitAccepted).resolves.toBe(false)
    await codeUnitFlush

    const entryWrite = createDeferred<boolean>()
    const entryWriteStarted = createDeferred<void>()
    const entryBuffer = createPtyPreconnectInputBuffer()
    const entryAccepted = entryBuffer.enqueueAccepted('first')
    for (let index = 1; index < PTY_PRECONNECT_INPUT_MAX_ENTRIES; index += 1) {
      expect(entryBuffer.enqueue('', 'ordinary')).toBe(true)
    }
    const entryFlush = entryBuffer.flush({
      isCurrent: () => true,
      sendInput: () => true,
      sendInputImmediate: () => true,
      sendInputAccepted: async () => {
        entryWriteStarted.resolve()
        return entryWrite.promise
      }
    })
    await entryWriteStarted.promise

    expect(entryBuffer.enqueue('', 'ordinary')).toBe(false)

    entryBuffer.clear()
    entryWrite.resolve(true)
    await expect(entryAccepted).resolves.toBe(false)
    await entryFlush
  })

  it('applies entry and code-unit caps to seeded input', async () => {
    const entryBuffer = createPtyPreconnectInputBuffer(
      Array.from({ length: PTY_PRECONNECT_INPUT_MAX_ENTRIES + 1 }, () => ({
        data: '',
        kind: 'ordinary' as const
      }))
    )
    let entryWrites = 0

    expect(entryBuffer.enqueue('', 'ordinary')).toBe(false)
    await entryBuffer.flush({
      isCurrent: () => true,
      sendInput: () => {
        entryWrites += 1
        return true
      },
      sendInputImmediate: () => true
    })
    expect(entryWrites).toBe(PTY_PRECONNECT_INPUT_MAX_ENTRIES)

    const codeUnitBuffer = createPtyPreconnectInputBuffer([
      { data: 'x'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS), kind: 'ordinary' },
      { data: 'overflow', kind: 'ordinary' }
    ])
    const codeUnitWrites: number[] = []

    expect(codeUnitBuffer.enqueue('new', 'ordinary')).toBe(false)
    await codeUnitBuffer.flush({
      isCurrent: () => true,
      sendInput: (data) => {
        codeUnitWrites.push(data.length)
        return true
      },
      sendInputImmediate: () => true
    })
    expect(codeUnitWrites).toEqual([PTY_PRECONNECT_INPUT_MAX_CODE_UNITS])
  })

  it('settles retained acknowledged input when the spawn is abandoned before connect', async () => {
    // Regression: an abandoned deferred spawn never reaches connect(), so nothing
    // drained the buffer and a paste awaiting sendInputAccepted hung forever.
    const buffer = createPtyPreconnectInputBuffer()
    const pastePending = buffer.enqueueAccepted('pasted text')
    let settled = false
    void pastePending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    buffer.clear()

    await expect(pastePending).resolves.toBe(false)
    expect(buffer.isBuffering()).toBe(false)
  })
})
