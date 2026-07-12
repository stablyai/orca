import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PRE_HANDLER_PTY_MAX_PTYS,
  bufferPreHandlerPtyData,
  bufferPreHandlerPtyExit,
  capturePreHandlerPtyEventCursor,
  clearPreHandlerPtyState,
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit
} from './pty-pre-handler-buffer'

const RESCAN_PTY_ID = 'pty-pre-handler-rescan'
const TRIM_PTY_ID = 'pty-pre-handler-trim'
const UTF8_TRIM_PTY_ID = 'pty-pre-handler-utf8-trim'
const REUSED_PTY_ID = 'pty-pre-handler-reused'
const EXIT_PTY_IDS = Array.from(
  { length: PRE_HANDLER_PTY_MAX_PTYS + 1 },
  (_, index) => `pty-pre-handler-exit-${index}`
)
const WARN_PTY_IDS = Array.from(
  { length: PRE_HANDLER_PTY_MAX_PTYS + 1 },
  (_, index) => `pty-pre-handler-warn-${index}`
)
const DATA_PTY_IDS = Array.from(
  { length: PRE_HANDLER_PTY_MAX_PTYS + 1 },
  (_, index) => `pty-pre-handler-data-${index}`
)

describe('pre-handler PTY buffer', () => {
  afterEach(() => {
    clearPreHandlerPtyState(RESCAN_PTY_ID)
    clearPreHandlerPtyState(TRIM_PTY_ID)
    clearPreHandlerPtyState(UTF8_TRIM_PTY_ID)
    clearPreHandlerPtyState(REUSED_PTY_ID)
    for (const ptyId of EXIT_PTY_IDS) {
      clearPreHandlerPtyState(ptyId)
    }
    for (const ptyId of WARN_PTY_IDS) {
      clearPreHandlerPtyState(ptyId)
    }
    for (const ptyId of DATA_PTY_IDS) {
      clearPreHandlerPtyState(ptyId)
    }
  })

  it('does not rescan historical chunks while buffering small startup output', () => {
    const originalReduce = Array.prototype.reduce

    try {
      Object.defineProperty(Array.prototype, 'reduce', {
        configurable: true,
        writable: true,
        value() {
          throw new Error('Array.reduce should not be used by the pre-handler PTY buffer')
        }
      })
      for (let index = 0; index < 4_096; index += 1) {
        bufferPreHandlerPtyData(RESCAN_PTY_ID, 'x')
      }
    } finally {
      Object.defineProperty(Array.prototype, 'reduce', {
        configurable: true,
        writable: true,
        value: originalReduce
      })
    }

    const drained: string[] = []
    drainPreHandlerPtyData(RESCAN_PTY_ID, (data) => drained.push(data))
    expect(drained).toHaveLength(4_096)
  })

  it('does not shift the live array while trimming a capped backlog', () => {
    const originalShift = Array.prototype.shift
    const originalWarn = console.warn

    try {
      console.warn = () => {}
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        writable: true,
        value() {
          throw new Error('Array.shift should not be used by the pre-handler PTY buffer')
        }
      })
      for (let index = 0; index < 2_048; index += 1) {
        bufferPreHandlerPtyData(TRIM_PTY_ID, 'x'.repeat(1_024))
      }
    } finally {
      console.warn = originalWarn
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        writable: true,
        value: originalShift
      })
    }

    const drained: string[] = []
    drainPreHandlerPtyData(TRIM_PTY_ID, (data) => drained.push(data))
    expect(drained).toHaveLength(512)
    expect(drained.join('')).toHaveLength(512 * 1_024)
  })

  it('keeps clamped UTF-8 bytes separate from UTF-16 stream sequence units', () => {
    const data = '😀'.repeat(200 * 1_024)
    bufferPreHandlerPtyData(UTF8_TRIM_PTY_ID, data, {
      seq: data.length,
      rawLength: data.length
    })

    const handler = vi.fn()
    drainPreHandlerPtyData(UTF8_TRIM_PTY_ID, handler)

    expect(handler).toHaveBeenCalledOnce()
    const [tail, meta] = handler.mock.calls[0]
    expect(tail).toHaveLength(256 * 1_024)
    expect(meta).toEqual({ seq: data.length, rawLength: tail.length })
  })

  it('bounds exits that arrive before any handler is registered', () => {
    for (let index = 0; index < EXIT_PTY_IDS.length; index += 1) {
      bufferPreHandlerPtyExit(EXIT_PTY_IDS[index], index)
    }

    let oldestExit: number | null = null
    drainPreHandlerPtyExit(EXIT_PTY_IDS[0], (code) => {
      oldestExit = code
    })
    let newestExit: number | null = null
    drainPreHandlerPtyExit(EXIT_PTY_IDS.at(-1)!, (code) => {
      newestExit = code
    })

    expect(oldestExit).toBeNull()
    expect(newestExit).toBe(PRE_HANDLER_PTY_MAX_PTYS)
  })

  it('keeps the latest exit for a reused PTY id and refreshes its recency', () => {
    bufferPreHandlerPtyExit(EXIT_PTY_IDS[0], 1)
    for (let index = 1; index < PRE_HANDLER_PTY_MAX_PTYS; index += 1) {
      bufferPreHandlerPtyExit(EXIT_PTY_IDS[index], index)
    }

    bufferPreHandlerPtyExit(EXIT_PTY_IDS[0], 99)
    bufferPreHandlerPtyExit(EXIT_PTY_IDS.at(-1)!, 100)

    const oldestHandler = vi.fn()
    drainPreHandlerPtyExit(EXIT_PTY_IDS[1], oldestHandler)
    expect(oldestHandler).not.toHaveBeenCalled()
    const reusedHandler = vi.fn()
    drainPreHandlerPtyExit(EXIT_PTY_IDS[0], reusedHandler)
    expect(reusedHandler).toHaveBeenCalledOnce()
    expect(reusedHandler).toHaveBeenCalledWith(99)
  })

  it('refreshes data recency when a reused PTY id receives current lifecycle output', () => {
    bufferPreHandlerPtyData(DATA_PTY_IDS[0], 'old-data')
    for (let index = 1; index < PRE_HANDLER_PTY_MAX_PTYS; index += 1) {
      bufferPreHandlerPtyData(DATA_PTY_IDS[index], `data-${index}`)
    }

    bufferPreHandlerPtyData(DATA_PTY_IDS[0], 'current-data')
    bufferPreHandlerPtyData(DATA_PTY_IDS.at(-1)!, 'newest-data')

    const oldestHandler = vi.fn()
    drainPreHandlerPtyData(DATA_PTY_IDS[1], oldestHandler)
    expect(oldestHandler).not.toHaveBeenCalled()
    const reusedHandler = vi.fn()
    drainPreHandlerPtyData(DATA_PTY_IDS[0], reusedHandler)
    expect(reusedHandler.mock.calls).toEqual([
      ['old-data', undefined],
      ['current-data', undefined]
    ])
  })

  it('clears an old lifecycle before a PTY id is reused and drains the new exit once', () => {
    const ptyId = EXIT_PTY_IDS[0]
    bufferPreHandlerPtyExit(ptyId, 1)
    clearPreHandlerPtyState(ptyId)
    bufferPreHandlerPtyExit(ptyId, 2)

    const handler = vi.fn()
    drainPreHandlerPtyExit(ptyId, handler)
    drainPreHandlerPtyExit(ptyId, handler)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(2)
  })

  it('filters an older lifecycle when a fresh spawn reuses the same PTY id', () => {
    bufferPreHandlerPtyData(REUSED_PTY_ID, 'old-data')
    bufferPreHandlerPtyExit(REUSED_PTY_ID, 1)
    const freshSpawnCursor = capturePreHandlerPtyEventCursor()
    bufferPreHandlerPtyData(REUSED_PTY_ID, 'new-data')
    bufferPreHandlerPtyExit(REUSED_PTY_ID, 2)

    const dataHandler = vi.fn()
    const exitHandler = vi.fn()
    drainPreHandlerPtyData(REUSED_PTY_ID, dataHandler, freshSpawnCursor)
    drainPreHandlerPtyExit(REUSED_PTY_ID, exitHandler, freshSpawnCursor)

    expect(dataHandler).toHaveBeenCalledOnce()
    expect(dataHandler).toHaveBeenCalledWith('new-data', undefined)
    expect(exitHandler).toHaveBeenCalledOnce()
    expect(exitHandler).toHaveBeenCalledWith(2)
  })

  it('bounds warned PTY identities with the data buffer eviction lifecycle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const warningChunk = 'x'.repeat(64 * 1_024 + 1)

    try {
      for (const ptyId of WARN_PTY_IDS) {
        bufferPreHandlerPtyData(ptyId, warningChunk)
      }
      expect(warn).toHaveBeenCalledTimes(PRE_HANDLER_PTY_MAX_PTYS + 1)

      // The first PTY was evicted when the 65th identity arrived. Reusing it
      // must be warnable again instead of remaining forever in the warning set.
      bufferPreHandlerPtyData(WARN_PTY_IDS[0], warningChunk)
      expect(warn).toHaveBeenCalledTimes(PRE_HANDLER_PTY_MAX_PTYS + 2)
    } finally {
      warn.mockRestore()
    }
  })
})
