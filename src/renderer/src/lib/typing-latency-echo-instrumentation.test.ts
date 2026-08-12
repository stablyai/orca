import { describe, expect, it } from 'vitest'
import {
  detachPaneEcho,
  instrumentPaneEcho,
  recordKeystroke,
  type EchoSample,
  type InstrumentedPane
} from './typing-latency-echo-instrumentation'

function emptyEntry(): InstrumentedPane {
  return { pane: {}, pending: [], disposables: [], restoreWrite: null }
}

type FakeTerminal = {
  write: (data: string | Uint8Array, callback?: () => void) => void
  onWriteParsed: (listener: () => void) => { dispose: () => void }
  onRender: (listener: () => void) => { dispose: () => void }
}

function fakeTerminal(): {
  terminal: FakeTerminal
  emitParsed: () => void
  emitRender: () => void
  writtenPayloads: (string | Uint8Array)[]
  disposeCount: () => number
} {
  const parsedListeners: (() => void)[] = []
  const renderListeners: (() => void)[] = []
  const writtenPayloads: (string | Uint8Array)[] = []
  let disposed = 0
  return {
    terminal: {
      write: (data) => {
        writtenPayloads.push(data)
      },
      onWriteParsed: (listener) => {
        parsedListeners.push(listener)
        return {
          dispose: () => {
            disposed += 1
          }
        }
      },
      onRender: (listener) => {
        renderListeners.push(listener)
        return {
          dispose: () => {
            disposed += 1
          }
        }
      }
    },
    emitParsed: () => parsedListeners.forEach((listener) => listener()),
    emitRender: () => renderListeners.forEach((listener) => listener()),
    writtenPayloads,
    disposeCount: () => disposed
  }
}

describe('recordKeystroke', () => {
  it('queues keystrokes rather than overwriting a single slot', () => {
    const entry = emptyEntry()
    expect(recordKeystroke(entry, 0)).toBe(0)
    expect(recordKeystroke(entry, 5)).toBe(0)
    expect(entry.pending.map((pending) => pending.t0)).toEqual([0, 5])
  })

  it('counts keystrokes whose echo never parsed as dropped', () => {
    const entry = emptyEntry()
    recordKeystroke(entry, 0)
    recordKeystroke(entry, 1)
    expect(recordKeystroke(entry, 5000)).toBe(2)
    expect(entry.pending).toHaveLength(1)
  })

  it('bounds the queue so sustained typing cannot grow memory', () => {
    const entry = emptyEntry()
    for (let index = 0; index < 200; index += 1) {
      recordKeystroke(entry, index)
    }
    expect(entry.pending.length).toBeLessThanOrEqual(64)
  })
})

describe('instrumentPaneEcho', () => {
  it('reports parse/paint latency and per-keystroke byte and write volume', () => {
    const fake = fakeTerminal()
    const samples: EchoSample[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (sample) => samples.push(sample))

    recordKeystroke(entry, performance.now())
    fake.terminal.write('a'.repeat(230))
    fake.terminal.write(new Uint8Array(6))
    fake.emitParsed()
    fake.emitRender()

    expect(samples).toHaveLength(1)
    expect(samples[0]?.bytes).toBe(236)
    expect(samples[0]?.writes).toBe(2)
    expect(samples[0]?.parseMs).toBeGreaterThanOrEqual(0)
    expect(samples[0]?.paintMs).toBeGreaterThanOrEqual(samples[0]?.parseMs ?? 0)
    // Wrapping write() must not swallow terminal output.
    expect(fake.writtenPayloads).toHaveLength(2)
  })

  it('holds an unparsed keystroke across a render instead of discarding it', () => {
    const fake = fakeTerminal()
    const samples: EchoSample[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (sample) => samples.push(sample))

    recordKeystroke(entry, performance.now())
    fake.emitRender()
    expect(samples).toHaveLength(0)

    fake.emitParsed()
    fake.emitRender()
    expect(samples).toHaveLength(1)
  })

  it('restores the original write and disposes listeners on detach', () => {
    const fake = fakeTerminal()
    const originalWrite = fake.terminal.write
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, () => undefined)
    expect(fake.terminal.write).not.toBe(originalWrite)

    detachPaneEcho(entry)

    expect(fake.terminal.write).toBe(originalWrite)
    expect(fake.disposeCount()).toBe(2)
    expect(entry.pending).toEqual([])
  })

  it('degrades to a no-op instead of throwing when the pane has no terminal', () => {
    const entry = instrumentPaneEcho({}, () => undefined)
    expect(entry.disposables).toEqual([])
    expect(() => detachPaneEcho(entry)).not.toThrow()
  })
})
