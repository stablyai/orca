// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTypingLatencyDiagnostic, type TypingDiagnosticBridge } from './diagnostic'
import * as diagnosticReport from './diagnostic-report'
import { instrumentPaneEcho, type PreventedKeystrokeDiscard } from './echo-instrumentation'
import { createEchoCandidate, createEchoObservation } from './echo-observation'
import type { TypingInputRegistration, TypingInputSignal } from './input-events'

const mocks = vi.hoisted(() => {
  const panes = [{ id: 1 }, { id: 2 }]
  return {
    discardUndispatchedKeystroke: vi.fn<() => PreventedKeystrokeDiscard>(() => null),
    detachInputEvents: vi.fn(),
    detachPaneEcho: vi.fn(() => 1),
    drainTimedOutEchoCandidates: vi.fn(() => 0),
    findPaneOwningFocus: vi.fn<() => object | null>(() => null),
    findPaneOwningNode: vi.fn<() => object | null>(() => null),
    inputListener: null as ((signal: TypingInputSignal) => TypingInputRegistration | void) | null,
    panes,
    recordKeystroke: vi.fn(() => ({ candidate: {}, unmatched: 0 }))
  }
})

vi.mock('./census-probe', () => ({
  countMountedAgentRows: () => 0,
  readFocusedPaneCensus: () => null,
  readProbeStoreState: () => null,
  readStoreListenerCount: () => 0
}))

vi.mock('./echo-instrumentation', () => ({
  detachPaneEcho: mocks.detachPaneEcho,
  discardUndispatchedKeystroke: mocks.discardUndispatchedKeystroke,
  drainTimedOutEchoCandidates: mocks.drainTimedOutEchoCandidates,
  findPaneOwningFocus: mocks.findPaneOwningFocus,
  findPaneOwningNode: mocks.findPaneOwningNode,
  instrumentPaneEcho: vi.fn((pane) => ({ pane })),
  listProbePanes: vi.fn(() => mocks.panes),
  recordKeystroke: mocks.recordKeystroke
}))

vi.mock('./input-events', () => ({
  installTypingLatencyInputEvents: vi.fn((_target, listener) => {
    mocks.inputListener = listener
    return mocks.detachInputEvents
  })
}))

type DiagnosticWindow = Window & { __orcaTypingDiagnostic?: TypingDiagnosticBridge }

describe('typing latency diagnostic lifecycle', () => {
  afterEach(() => {
    delete (window as DiagnosticWindow).__orcaTypingDiagnostic
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('releases stopped pane state while preserving the instrumented count', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge) {
      throw new Error('Typing latency diagnostic bridge was not installed')
    }

    bridge.start()
    expect(bridge.report().sampling.instrumentedPanes).toBe(2)
    bridge.stop()

    expect(mocks.detachInputEvents).toHaveBeenCalledOnce()
    expect(mocks.detachPaneEcho).toHaveBeenCalledTimes(2)
    expect(bridge.report()).toMatchObject({
      sampling: { instrumentedPanes: 2, unmatchedKeystrokes: 2 },
      census: { panes: { instrumented: 2 } }
    })

    const inputListener = mocks.inputListener
    if (!inputListener) {
      throw new Error('Typing latency input listener was not installed')
    }
    const event = new KeyboardEvent('keydown', { key: 'a' })
    Object.defineProperty(event, 'target', { value: document.body })
    inputListener({ event, source: 'direct', text: 'a' })

    expect(mocks.findPaneOwningNode).toHaveBeenLastCalledWith([], document.body)
    expect(mocks.findPaneOwningFocus).toHaveBeenLastCalledWith([])
  })

  it('retains echo timings without typed text during and after a diagnostic', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const buildReport = vi.spyOn(diagnosticReport, 'buildTypingLatencyReport')
    const pending = [{ startTime: 90, duration: 100 }]
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['long-animation-frame']
        observe(): void {}
        disconnect(): void {}
        takeRecords(): typeof pending {
          return pending.splice(0)
        }
      }
    )
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge) {
      throw new Error('Typing latency diagnostic bridge was not installed')
    }

    bridge.start()
    const onObservation = vi.mocked(instrumentPaneEcho).mock.lastCall?.[1]
    if (!onObservation) {
      throw new Error('Pane echo instrumentation was not installed')
    }
    for (const source of ['direct', 'ime'] as const) {
      const observation = createEchoObservation(
        {
          candidates: [
            {
              ...createEchoCandidate(110, source, source === 'direct' ? 100 : null),
              dispatchedAt: 120,
              arrivedAt: 130
            }
          ],
          hasAttributionGap: false,
          outputBytes: 1,
          outputWrites: 1,
          firstWriteAt: 140,
          parsedAt: 150
        },
        160
      )
      if (!observation) {
        throw new Error('Echo observation was not created')
      }
      const observationWithText = { ...observation, text: source === 'direct' ? 'a' : '한' }
      onObservation(observationWithText)
    }

    const runningReport = bridge.report()
    expect(runningReport).toMatchObject({
      sampling: { exactInputs: 2 },
      exact: {
        inputToPaintMs: { count: 2, p50: 50 },
        eventToPaintMs: { count: 1, p50: 60 }
      },
      byInputSource: { direct: { exactInputs: 1 }, ime: { exactInputs: 1 } },
      longTaskOverlap: {
        exactSamples: 2,
        exactSamplesOverlapped: 2,
        overlapMs: { count: 2, p50: 50, p95: 60, max: 60 },
        slowestExactSamples: [
          {
            echoMs: 60,
            longTaskOverlapMs: 60,
            eventToHandlerMs: 10,
            inputToDispatchMs: 10,
            dispatchToArrivalMs: 10,
            arrivalToWriteMs: 10,
            writeToParseMs: 10,
            parseToPaintMs: 10
          },
          { echoMs: 50, eventToHandlerMs: null, longTaskOverlapMs: 50 }
        ]
      }
    })
    const runningSamples = buildReport.mock.lastCall?.[0]?.exactSamples
    expect(runningSamples).toHaveLength(2)
    for (const sample of runningSamples ?? []) {
      expect(sample).not.toHaveProperty('text')
    }

    bridge.stop()
    const stoppedReport = bridge.report()
    expect(stoppedReport.exact).toEqual(runningReport.exact)
    expect(stoppedReport.longTaskOverlap).toEqual(runningReport.longTaskOverlap)
    const stoppedSamples = buildReport.mock.lastCall?.[0]?.exactSamples
    expect(stoppedSamples).toHaveLength(2)
    for (const sample of stoppedSamples ?? []) {
      expect(sample).not.toHaveProperty('text')
    }
  })

  it('includes queued stalls in live reports and keeps observing until stop', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const pending: { startTime: number; duration: number }[] = []
    const disconnect = vi.fn()
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['long-animation-frame']
        observe(): void {}
        disconnect = disconnect
        takeRecords(): typeof pending {
          return pending.splice(0)
        }
      }
    )
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge) {
      throw new Error('Typing latency diagnostic bridge was not installed')
    }

    bridge.start()
    pending.push({ startTime: 100, duration: 60 })
    expect(bridge.report().longTaskOverlap).toMatchObject({
      observedTasks: 1,
      observedTaskMs: 60
    })
    expect(bridge.report().longTaskOverlap.observedTasks).toBe(1)
    expect(disconnect).not.toHaveBeenCalled()

    pending.push({ startTime: 200, duration: 80 })
    expect(bridge.report().longTaskOverlap).toMatchObject({
      observedTasks: 2,
      observedTaskMs: 140
    })
    pending.push({ startTime: 300, duration: 70 })
    bridge.stop()
    expect(bridge.report().longTaskOverlap).toMatchObject({
      observedTasks: 3,
      observedTaskMs: 210
    })
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
