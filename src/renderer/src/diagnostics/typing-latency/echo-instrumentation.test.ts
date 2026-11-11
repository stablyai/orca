import { afterEach, describe, expect, it, vi } from 'vitest'
import { instrumentPaneEcho, recordKeystroke, type InstrumentedPane } from './echo-instrumentation'
import type { EchoObservation } from './echo-observation'

type FakeTerminal = {
  write: (data: string | Uint8Array, callback?: () => void) => void
  onData: (listener: (data: string) => void) => { dispose: () => void }
  onWriteParsed: (listener: () => void) => { dispose: () => void }
  onRender: (listener: () => void) => { dispose: () => void }
}

function fakeTerminal(): {
  terminal: FakeTerminal
  emitData: (data?: string) => void
  emitParsed: () => void
  emitRender: () => void
  writtenPayloads: (string | Uint8Array)[]
} {
  const dataListeners = new Set<(data: string) => void>()
  const parsedListeners = new Set<() => void>()
  const renderListeners = new Set<() => void>()
  const writtenPayloads: (string | Uint8Array)[] = []
  const listen = <T>(listeners: Set<T>, listener: T): { dispose: () => void } => {
    listeners.add(listener)
    return {
      dispose: () => {
        listeners.delete(listener)
      }
    }
  }
  return {
    terminal: {
      write: (data) => writtenPayloads.push(data),
      onData: (listener) => listen(dataListeners, listener),
      onWriteParsed: (listener) => listen(parsedListeners, listener),
      onRender: (listener) => listen(renderListeners, listener)
    },
    emitData: (data = 'x') => dataListeners.forEach((listener) => listener(data)),
    emitParsed: () => parsedListeners.forEach((listener) => listener()),
    emitRender: () => renderListeners.forEach((listener) => listener()),
    writtenPayloads
  }
}

function recordAndDispatch(
  entry: InstrumentedPane,
  fake: ReturnType<typeof fakeTerminal>,
  source: 'direct' | 'ime' = 'direct',
  recordedAt: number = performance.now()
): void {
  recordKeystroke(entry, recordedAt, source)
  fake.emitData()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('instrumentPaneEcho', () => {
  it('does not credit output that arrived before the input dispatched', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordKeystroke(entry, performance.now(), 'direct')
    fake.terminal.write('unrelated')
    fake.emitParsed()
    fake.emitRender()
    expect(observations).toEqual([])

    fake.emitData()
    fake.terminal.write('echo')
    fake.emitParsed()
    fake.emitRender()
    expect(observations).toHaveLength(1)
  })

  it('emits one ambiguous burst when overlapping inputs receive separate outputs', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake, 'direct')
    recordAndDispatch(entry, fake, 'direct')
    fake.terminal.write('A')
    fake.emitParsed()
    fake.emitRender()
    fake.terminal.write('B')
    fake.emitParsed()
    fake.emitRender()

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      attribution: 'ambiguous-burst',
      reason: 'overlapping-inputs',
      inputCount: 2,
      sourceCounts: { direct: 2, ime: 0 },
      outputBatchBytes: 1,
      outputBatchWrites: 1
    })
  })

  it('keeps a batch ambiguous when another input arrives before parsing finishes', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake)
    fake.terminal.write('x'.repeat(90))
    recordAndDispatch(entry, fake)
    fake.terminal.write('x'.repeat(30))
    fake.emitParsed()
    fake.emitRender()

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      attribution: 'ambiguous-burst',
      inputCount: 2,
      outputBatchBytes: 120,
      outputBatchWrites: 2
    })
  })

  it('keeps parsed batches separate when two parses precede one render', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake)
    fake.terminal.write('a')
    fake.emitParsed()
    recordAndDispatch(entry, fake)
    fake.terminal.write('b')
    fake.emitParsed()
    fake.emitRender()

    expect(observations.map((value) => value.attribution)).toEqual(['single-input', 'single-input'])
  })

  it('marks the first late output after a timeout as ambiguous, then restores confidence', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )
    const now = vi.spyOn(performance, 'now')

    recordKeystroke(entry, 0, 'direct')
    now.mockReturnValueOnce(1)
    fake.emitData('A')
    expect(recordKeystroke(entry, 5_000, 'direct').unmatched).toBe(1)
    now.mockReturnValueOnce(5_001)
    fake.emitData('B')
    fake.terminal.write('late A')
    now.mockReturnValueOnce(5_010)
    fake.emitParsed()
    now.mockReturnValueOnce(5_015)
    fake.emitRender()

    recordKeystroke(entry, 5_020, 'ime')
    now.mockReturnValueOnce(5_021)
    fake.emitData('한')
    fake.terminal.write('한')
    now.mockReturnValueOnce(5_030)
    fake.emitParsed()
    now.mockReturnValueOnce(5_035)
    fake.emitRender()

    expect(observations[0]).toMatchObject({
      attribution: 'ambiguous-burst',
      reason: 'attribution-gap',
      inputCount: 1
    })
    expect(observations[1]).toMatchObject({
      attribution: 'single-input',
      source: 'ime'
    })
  })

  it('holds an unparsed input across a render instead of discarding it', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake)
    fake.terminal.write('echo')
    fake.emitRender()
    expect(observations).toHaveLength(0)

    fake.emitParsed()
    fake.emitRender()
    expect(observations).toHaveLength(1)
  })
})
