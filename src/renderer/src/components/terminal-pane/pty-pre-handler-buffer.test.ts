import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferPreHandlerPtyData,
  bufferPreHandlerPtyExit,
  clearConsumedPreHandlerPtyExit,
  clearPreHandlerPtyState,
  consumePreHandlerPtyState,
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit,
  discardPreHandlerPtyState,
  hasPreHandlerPtyExit
} from './pty-pre-handler-buffer'

const RESCAN_PTY_ID = 'pty-pre-handler-rescan'
const TRIM_PTY_ID = 'pty-pre-handler-trim'
const EXIT_PTY_ID = 'pty-pre-handler-exit'
const CAPPED_EXIT_PTY_IDS = Array.from({ length: 65 }, (_, index) => `pty-capped-exit-${index}`)

describe('pre-handler PTY buffer', () => {
  afterEach(() => {
    clearPreHandlerPtyState(RESCAN_PTY_ID)
    clearPreHandlerPtyState(TRIM_PTY_ID)
    clearPreHandlerPtyState(EXIT_PTY_ID)
    for (const ptyId of CAPPED_EXIT_PTY_IDS) {
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

  it('suppresses duplicate exits after an owner consumes the pre-handler state', () => {
    const onExit = vi.fn()
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 1)
    consumePreHandlerPtyState(EXIT_PTY_ID)
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 2)

    drainPreHandlerPtyExit(EXIT_PTY_ID, onExit)
    expect(onExit).not.toHaveBeenCalled()

    bufferPreHandlerPtyData(EXIT_PTY_ID, 'reattach output')
    clearConsumedPreHandlerPtyExit(EXIT_PTY_ID)
    const data: string[] = []
    drainPreHandlerPtyData(EXIT_PTY_ID, (chunk) => data.push(chunk))
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 3)
    drainPreHandlerPtyExit(EXIT_PTY_ID, onExit)
    expect(data).toEqual(['reattach output'])
    expect(onExit).toHaveBeenCalledWith(3)
  })

  it('consumes a drained exit even when its handler throws', () => {
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 7)
    expect(() =>
      drainPreHandlerPtyExit(EXIT_PTY_ID, () => {
        throw new Error('exit handler failed')
      })
    ).toThrow('exit handler failed')

    bufferPreHandlerPtyExit(EXIT_PTY_ID, 8)
    const duplicateExit = vi.fn()
    drainPreHandlerPtyExit(EXIT_PTY_ID, duplicateExit)
    expect(duplicateExit).not.toHaveBeenCalled()
  })

  it('reports whether an undelivered exit is waiting for admission', () => {
    expect(hasPreHandlerPtyExit(EXIT_PTY_ID)).toBe(false)
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 7)
    expect(hasPreHandlerPtyExit(EXIT_PTY_ID)).toBe(true)
    drainPreHandlerPtyExit(EXIT_PTY_ID, vi.fn())
    expect(hasPreHandlerPtyExit(EXIT_PTY_ID)).toBe(false)
  })

  it('discards delayed data and exit until an explicit reconnect', () => {
    discardPreHandlerPtyState(EXIT_PTY_ID)
    bufferPreHandlerPtyData(EXIT_PTY_ID, 'late data')
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 9)
    const data = vi.fn()
    const exit = vi.fn()
    drainPreHandlerPtyData(EXIT_PTY_ID, data)
    drainPreHandlerPtyExit(EXIT_PTY_ID, exit)
    expect(data).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()

    clearConsumedPreHandlerPtyExit(EXIT_PTY_ID)
    bufferPreHandlerPtyData(EXIT_PTY_ID, 'new incarnation')
    drainPreHandlerPtyData(EXIT_PTY_ID, data)
    expect(data).toHaveBeenCalledWith('new incarnation', undefined)
  })

  it('retains discard protection beyond the bounded exit-buffer capacity', () => {
    for (const ptyId of CAPPED_EXIT_PTY_IDS) {
      discardPreHandlerPtyState(ptyId)
    }

    bufferPreHandlerPtyData(CAPPED_EXIT_PTY_IDS[0], 'late data')
    bufferPreHandlerPtyExit(CAPPED_EXIT_PTY_IDS[0], 9)
    const data = vi.fn()
    const exit = vi.fn()
    drainPreHandlerPtyData(CAPPED_EXIT_PTY_IDS[0], data)
    drainPreHandlerPtyExit(CAPPED_EXIT_PTY_IDS[0], exit)
    expect(data).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('caps exits buffered without a primary handler', () => {
    for (const [code, ptyId] of CAPPED_EXIT_PTY_IDS.entries()) {
      bufferPreHandlerPtyExit(ptyId, code)
    }

    const exits: number[] = []
    for (const ptyId of CAPPED_EXIT_PTY_IDS) {
      drainPreHandlerPtyExit(ptyId, (code) => exits.push(code))
    }
    expect(exits).toHaveLength(64)
    expect(exits).not.toContain(0)
    expect(exits).toContain(64)
  })
})
