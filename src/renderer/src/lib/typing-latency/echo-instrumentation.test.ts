import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  detachPaneEcho,
  discardUndispatchedKeystroke,
  drainTimedOutEchoCandidates,
  instrumentPaneEcho,
  recordKeystroke,
  type EchoObservation,
  type InstrumentedPane
} from './echo-instrumentation'

function emptyEntry(): InstrumentedPane {
  return {
    pane: {},
    undispatched: [],
    nextDispatch: null,
    deferredNextDispatch: null,
    ignoredDispatches: [],
    ignoredDispatchOverflowedAt: null,
    awaitingEcho: [],
    attributionGap: false,
    parsingBatch: null,
    parsedBatches: [],
    pendingCount: 0,
    disposables: [],
    restoreWrite: null
  }
}

type FakeTerminal = {
  write: (data: string | Uint8Array, callback?: () => void) => void
  onData: (listener: (data: string) => void) => { dispose: () => void }
  onWriteParsed: (listener: () => void) => { dispose: () => void }
  onRender: (listener: () => void) => { dispose: () => void }
}

type CoreServiceAccess = {
  _core: {
    coreService: {
      triggerDataEvent: (data: string, wasUserInput?: boolean) => void
    }
  }
}

function fakeTerminal(): {
  terminal: FakeTerminal
  emitData: (data?: string) => void
  emitParsed: () => void
  emitRender: () => void
  writtenPayloads: (string | Uint8Array)[]
  disposeCount: () => number
} {
  const dataListeners = new Set<(data: string) => void>()
  const parsedListeners = new Set<() => void>()
  const renderListeners = new Set<() => void>()
  const writtenPayloads: (string | Uint8Array)[] = []
  let disposed = 0
  const listen = <T>(listeners: Set<T>, listener: T): { dispose: () => void } => {
    listeners.add(listener)
    return {
      dispose: () => {
        if (listeners.delete(listener)) {
          disposed += 1
        }
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
    writtenPayloads,
    disposeCount: () => disposed
  }
}

function recordAndDispatch(
  entry: InstrumentedPane,
  fake: ReturnType<typeof fakeTerminal>,
  source: 'direct' | 'ime' = 'direct',
  recordedAt: number = performance.now(),
  text: string = ''
): void {
  recordKeystroke(entry, recordedAt, source, text)
  fake.emitData()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('recordKeystroke', () => {
  it('queues inputs rather than overwriting a single slot', () => {
    const entry = emptyEntry()
    expect(recordKeystroke(entry, 0, 'direct').unmatched).toBe(0)
    expect(recordKeystroke(entry, 5, 'ime').unmatched).toBe(0)
    expect(entry.undispatched.map((pending) => pending.t0)).toEqual([0, 5])
    expect(entry.pendingCount).toBe(2)
  })

  it('counts timed-out undispatched inputs without creating an output attribution gap', () => {
    const entry = emptyEntry()
    recordKeystroke(entry, 0, 'direct')
    recordKeystroke(entry, 1, 'direct')
    expect(recordKeystroke(entry, 5000, 'direct').unmatched).toBe(2)
    expect(entry.pendingCount).toBe(1)
    expect(entry.attributionGap).toBe(false)
  })

  it('drains a final timed-out input without waiting for another keystroke', () => {
    const entry = emptyEntry()
    const recorded = recordKeystroke(entry, 0, 'direct')

    expect(drainTimedOutEchoCandidates(entry, 2_001)).toBe(1)
    expect(drainTimedOutEchoCandidates(entry, 2_002)).toBe(0)
    expect(recorded.candidate.status).toBe('unmatched-undispatched')
    expect(entry.pendingCount).toBe(0)
  })

  it('reverses timeout accounting when an undispatched IME commit settles prevented', () => {
    const entry = emptyEntry()
    const recorded = recordKeystroke(entry, 0, 'ime', '한')

    expect(drainTimedOutEchoCandidates(entry, 2_001)).toBe(1)
    expect(discardUndispatchedKeystroke(entry, recorded.candidate)).toBe('counted-unmatched')
    expect(discardUndispatchedKeystroke(entry, recorded.candidate)).toBeNull()
    expect(entry).toMatchObject({ pendingCount: 0, ignoredDispatches: [] })
  })

  it('keeps timeout accounting when the IME commit reached terminal input', () => {
    const fake = fakeTerminal()
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, () => undefined)
    const recorded = recordKeystroke(entry, 0, 'ime', '한')
    fake.emitData('한')

    expect(drainTimedOutEchoCandidates(entry, 2_001)).toBe(1)
    expect(recorded.candidate.status).toBe('unmatched-dispatched')
    expect(discardUndispatchedKeystroke(entry, recorded.candidate)).toBeNull()
    expect(entry.pendingCount).toBe(0)
  })

  it('bounds pending input state during sustained typing', () => {
    const entry = emptyEntry()
    let dropped = 0
    const records: ReturnType<typeof recordKeystroke>[] = []
    for (let index = 0; index < 200; index += 1) {
      const recorded = recordKeystroke(entry, index, 'direct')
      dropped += recorded.unmatched
      records.push(recorded)
    }
    expect(entry.pendingCount).toBe(64)
    expect(entry.undispatched).toHaveLength(64)
    expect(entry.ignoredDispatches).toHaveLength(64)
    expect(dropped).toBe(136)
    expect(discardUndispatchedKeystroke(entry, records[64]!.candidate)).toBe('counted-unmatched')
    expect(entry.ignoredDispatches).toHaveLength(64)
  })

  it('drops a prevented commit only when it never dispatched', () => {
    const fake = fakeTerminal()
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, () => undefined)
    const prevented = recordKeystroke(entry, 10, 'ime', '한')
    expect(discardUndispatchedKeystroke(entry, prevented.candidate)).toBe('pending')

    const dispatched = recordKeystroke(entry, 20, 'ime', '글')
    fake.emitData('글')
    expect(discardUndispatchedKeystroke(entry, dispatched.candidate)).toBeNull()
    expect(entry.awaitingEcho).toHaveLength(1)
  })

  it('dispatches a nested IME finalizer before its outer direct key', () => {
    const fake = fakeTerminal()
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, () => undefined)
    recordKeystroke(entry, 10, 'direct', 'Enter')
    recordKeystroke(entry, 11, 'ime', '한')

    fake.emitData('한')
    fake.emitData('\r')

    expect(entry.awaitingEcho.map((pending) => pending.source)).toEqual(['ime', 'direct'])
  })

  it('uses a cap-rejection sentinel instead of consuming a retained input', () => {
    const fake = fakeTerminal()
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, () => undefined)
    for (let index = 0; index < 64; index += 1) {
      recordKeystroke(entry, index, 'direct')
    }

    expect(recordKeystroke(entry, 64, 'direct').unmatched).toBe(1)
    fake.emitData('rejected')

    expect(entry.undispatched).toHaveLength(64)
    expect(entry.awaitingEcho).toEqual([])
    expect(entry.pendingCount).toBe(64)
    expect(entry.attributionGap).toBe(true)
  })

  it('fences overflow dispatches without consuming retained inputs', () => {
    const fake = fakeTerminal()
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, () => undefined)
    for (let index = 0; index < 64; index += 1) {
      recordKeystroke(entry, index, 'direct')
    }
    for (let index = 64; index < 129; index += 1) {
      recordKeystroke(entry, index, 'direct')
    }

    expect(entry.ignoredDispatches).toHaveLength(64)
    expect(entry.ignoredDispatchOverflowedAt).toBe(128)
    for (let index = 0; index < 65; index += 1) {
      fake.emitData('rejected')
    }

    expect(entry.undispatched).toHaveLength(64)
    expect(entry).toMatchObject({
      awaitingEcho: [],
      pendingCount: 64,
      ignoredDispatches: [],
      ignoredDispatchOverflowedAt: 128
    })
    expect(drainTimedOutEchoCandidates(entry, 2_129)).toBe(64)
    expect(entry).toMatchObject({
      undispatched: [],
      pendingCount: 0,
      ignoredDispatchOverflowedAt: null
    })
    const recovered = recordKeystroke(entry, 2_130, 'direct')
    fake.emitData('recovered')
    expect(entry.awaitingEcho).toEqual([recovered.candidate])
  })

  it('settles a prevented cap-rejected commit without touching retained inputs', () => {
    const entry = emptyEntry()
    for (let index = 0; index < 64; index += 1) {
      recordKeystroke(entry, index, 'direct')
    }

    const rejected = recordKeystroke(entry, 64, 'ime', '한')
    expect(rejected.unmatched).toBe(1)
    expect(discardUndispatchedKeystroke(entry, rejected.candidate)).toBe('counted-unmatched')
    expect(entry.undispatched).toHaveLength(64)
    expect(entry.ignoredDispatches).toEqual([])
    expect(entry.attributionGap).toBe(false)
  })

  it('settles overlapping cap-rejected commits by identity', () => {
    const entry = emptyEntry()
    for (let index = 0; index < 64; index += 1) {
      recordKeystroke(entry, index, 'direct')
    }

    const first = recordKeystroke(entry, 64, 'ime', '한')
    const second = recordKeystroke(entry, 65, 'ime', '글')
    expect(first.unmatched).toBe(1)
    expect(second.unmatched).toBe(1)
    expect(discardUndispatchedKeystroke(entry, first.candidate)).toBe('counted-unmatched')
    expect(discardUndispatchedKeystroke(entry, second.candidate)).toBe('counted-unmatched')
    expect(entry.undispatched).toHaveLength(64)
    expect(entry.ignoredDispatches).toEqual([])
    expect(entry.attributionGap).toBe(false)
  })

  it('settles same-timestamp cap rejections independently', () => {
    const entry = emptyEntry()
    for (let index = 0; index < 64; index += 1) {
      recordKeystroke(entry, index, 'direct')
    }

    const first = recordKeystroke(entry, 64, 'ime', '한')
    const second = recordKeystroke(entry, 64, 'ime', '글')

    expect(discardUndispatchedKeystroke(entry, first.candidate)).toBe('counted-unmatched')
    expect(discardUndispatchedKeystroke(entry, second.candidate)).toBe('counted-unmatched')
    expect(entry.ignoredDispatches).toEqual([])
  })
})

describe('instrumentPaneEcho', () => {
  it('does not attribute parser replies as user dispatches', () => {
    const terminal = new Terminal({ allowProposedApi: true })
    const entry = instrumentPaneEcho({ terminal }, () => undefined)
    const coreService = (terminal as unknown as CoreServiceAccess)._core.coreService

    recordKeystroke(entry, 10, 'direct', 'a')
    coreService.triggerDataEvent('\x1b[?1;2c', false)
    expect(entry.undispatched).toHaveLength(1)
    expect(entry.awaitingEcho).toEqual([])

    coreService.triggerDataEvent('a', true)
    expect(entry.undispatched).toEqual([])
    expect(entry.awaitingEcho).toHaveLength(1)

    detachPaneEcho(entry)
    terminal.dispose()
  })

  it('measures input, dispatch, parse, and paint stages separately', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )
    const now = vi.spyOn(performance, 'now')

    recordKeystroke(entry, 10, 'direct', 'a')
    now.mockReturnValueOnce(25)
    fake.emitData('a')
    fake.terminal.write('echo')
    now.mockReturnValueOnce(40)
    fake.emitParsed()
    now.mockReturnValueOnce(50)
    fake.emitRender()

    expect(observations).toEqual([
      {
        attribution: 'single-input',
        source: 'direct',
        text: 'a',
        inputToDispatchMs: 15,
        dispatchToParseMs: 15,
        parseToPaintMs: 10,
        inputToPaintMs: 40,
        outputBytes: 4,
        outputWrites: 1
      }
    ])
  })

  it('counts UTF-8 bytes consistently for string and binary writes', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake, 'ime', performance.now(), '한𠀀')
    fake.terminal.write('한𠀀')
    fake.terminal.write(new Uint8Array(6))
    fake.emitParsed()
    fake.emitRender()

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      attribution: 'single-input',
      outputBytes: 13,
      outputWrites: 2
    })
    expect(fake.writtenPayloads).toHaveLength(2)
  })

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

  it('emits one aggregate observation for genuinely coalesced mixed-source output', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake, 'direct')
    recordAndDispatch(entry, fake, 'ime')
    fake.terminal.write('x'.repeat(90))
    fake.emitParsed()
    fake.emitRender()

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      attribution: 'ambiguous-burst',
      inputCount: 2,
      sourceCounts: { direct: 1, ime: 1 },
      outputBatchBytes: 90,
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

  it('aggregates thousands of writes in constant-size batch accounting', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake)
    for (let index = 0; index < 1_000; index += 1) {
      fake.terminal.write('x')
    }

    expect(entry.parsingBatch).toMatchObject({ outputBytes: 1_000, outputWrites: 1_000 })
    expect(entry.parsingBatch?.candidates).toHaveLength(1)
    fake.emitParsed()
    fake.emitRender()
    expect(observations[0]).toMatchObject({ outputBytes: 1_000, outputWrites: 1_000 })
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

    recordKeystroke(entry, 0, 'direct', 'A')
    now.mockReturnValueOnce(1)
    fake.emitData('A')
    expect(recordKeystroke(entry, 5_000, 'direct', 'B').unmatched).toBe(1)
    now.mockReturnValueOnce(5_001)
    fake.emitData('B')
    fake.terminal.write('late A')
    now.mockReturnValueOnce(5_010)
    fake.emitParsed()
    now.mockReturnValueOnce(5_015)
    fake.emitRender()

    recordKeystroke(entry, 5_020, 'ime', '한')
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
      source: 'ime',
      text: '한'
    })
  })

  it('clears a gap-only output boundary without retaining an empty parsed batch', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )
    const now = vi.spyOn(performance, 'now')

    recordKeystroke(entry, 0, 'direct', 'A')
    now.mockReturnValueOnce(1)
    fake.emitData('A')
    expect(recordKeystroke(entry, 5_000, 'direct', 'B').unmatched).toBe(1)
    fake.terminal.write('late A')
    now.mockReturnValueOnce(5_001)
    fake.emitParsed()

    expect(entry.parsedBatches).toEqual([])
    now.mockReturnValueOnce(5_002)
    fake.emitData('B')
    fake.terminal.write('B')
    now.mockReturnValueOnce(5_010)
    fake.emitParsed()
    now.mockReturnValueOnce(5_015)
    fake.emitRender()

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ attribution: 'single-input', text: 'B' })
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

  it('drains parsed output that never paints exactly once', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake, 'direct', 0, 'A')
    fake.terminal.write('A')
    fake.emitParsed()

    expect(drainTimedOutEchoCandidates(entry, 2_001)).toBe(1)
    expect(drainTimedOutEchoCandidates(entry, 2_002)).toBe(0)
    expect(entry).toMatchObject({ parsedBatches: [], pendingCount: 0 })

    recordAndDispatch(entry, fake, 'direct', 2_003, 'B')
    fake.terminal.write('B')
    fake.emitParsed()
    fake.emitRender()

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ attribution: 'single-input', text: 'B' })
    expect(entry.pendingCount).toBe(0)
  })

  it('keeps a shared unparsed batch ambiguous after draining its stale input', () => {
    const fake = fakeTerminal()
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )

    recordAndDispatch(entry, fake, 'direct', 0, 'A')
    fake.terminal.write('late A')
    expect(drainTimedOutEchoCandidates(entry, 2_001)).toBe(1)

    recordAndDispatch(entry, fake, 'direct', 2_002, 'B')
    fake.terminal.write('B')
    fake.emitParsed()
    fake.emitRender()

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      attribution: 'ambiguous-burst',
      reason: 'attribution-gap',
      inputCount: 1
    })
    expect(entry.pendingCount).toBe(0)
  })

  it('returns trailing unmatched inputs and releases pane and listener closures', () => {
    const fake = fakeTerminal()
    const originalWrite = fake.terminal.write
    const observations: EchoObservation[] = []
    const entry = instrumentPaneEcho({ terminal: fake.terminal }, (value) =>
      observations.push(value)
    )
    recordAndDispatch(entry, fake)
    fake.terminal.write('parsed but not painted')
    fake.emitParsed()
    recordKeystroke(entry, performance.now(), 'direct')

    expect(detachPaneEcho(entry)).toBe(2)
    expect(fake.terminal.write).toBe(originalWrite)
    expect(fake.disposeCount()).toBe(3)
    expect(entry).toMatchObject({ pane: null, pendingCount: 0, restoreWrite: null })

    fake.emitRender()
    fake.emitData()
    expect(observations).toEqual([])
  })

  it('degrades to a no-op when the pane has no terminal', () => {
    const entry = instrumentPaneEcho({}, () => undefined)
    expect(entry.disposables).toEqual([])
    expect(detachPaneEcho(entry)).toBe(0)
    expect(entry.pane).toBeNull()
  })
})
