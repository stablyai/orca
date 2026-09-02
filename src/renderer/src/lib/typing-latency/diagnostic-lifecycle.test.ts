// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTypingLatencyDiagnostic, type TypingDiagnosticBridge } from './diagnostic'
import type { PreventedKeystrokeDiscard } from './echo-instrumentation'
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

  it('counts timed-out trailing inputs in a live report exactly once', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mocks.drainTimedOutEchoCandidates.mockReturnValueOnce(1)
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge) {
      throw new Error('Typing latency diagnostic bridge was not installed')
    }

    bridge.start()
    expect(bridge.report().sampling.unmatchedKeystrokes).toBe(1)
    expect(bridge.report().sampling.unmatchedKeystrokes).toBe(1)
    bridge.stop()
  })

  it('reverses a timeout count when the IME commit later settles prevented', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mocks.findPaneOwningNode.mockReturnValueOnce({ pane: mocks.panes[0] })
    mocks.drainTimedOutEchoCandidates.mockReturnValueOnce(1)
    mocks.discardUndispatchedKeystroke.mockReturnValueOnce('counted-unmatched')
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge || !mocks.inputListener) {
      throw new Error('Typing latency diagnostic did not start')
    }
    bridge.start()

    const registration = mocks.inputListener({
      event: new CustomEvent('xterm-composition-session-end'),
      source: 'ime',
      text: '한'
    })
    expect(bridge.report().sampling.unmatchedKeystrokes).toBe(1)
    registration?.settleAfterPropagation(true)

    expect(bridge.report()).toMatchObject({
      sampling: { unmatchedKeystrokes: 0 },
      byInputSource: { ime: { observedInputs: 0 } }
    })
    bridge.stop()
  })

  it('does not count a stale prevented IME commit', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mocks.findPaneOwningNode.mockReturnValueOnce({ pane: mocks.panes[0] })
    mocks.discardUndispatchedKeystroke.mockReturnValueOnce('pending')
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge || !mocks.inputListener) {
      throw new Error('Typing latency diagnostic did not start')
    }
    bridge.start()

    const registration = mocks.inputListener({
      event: new CustomEvent('xterm-composition-session-end'),
      source: 'ime',
      text: '한'
    })
    registration?.settleAfterPropagation(true)

    expect(bridge.report()).toMatchObject({
      sampling: { unmatchedKeystrokes: 0 },
      byInputSource: {
        ime: { observedInputs: 0 },
        imeCommitChars: { count: 0 }
      }
    })
    bridge.stop()
  })

  it('counts a prevented IME commit that reached terminal input', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mocks.findPaneOwningNode.mockReturnValueOnce({ pane: mocks.panes[0] })
    mocks.discardUndispatchedKeystroke.mockReturnValueOnce(null)
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge || !mocks.inputListener) {
      throw new Error('Typing latency diagnostic did not start')
    }
    bridge.start()

    const registration = mocks.inputListener({
      event: new CustomEvent('xterm-composition-session-end'),
      source: 'ime',
      text: '한'
    })
    registration?.settleAfterPropagation(true)

    expect(bridge.report().byInputSource).toMatchObject({
      ime: { observedInputs: 1 },
      imeCommitChars: { count: 1, p50: 1 }
    })
    bridge.stop()
  })

  it('removes queue-cap accounting when a prevented IME commit was not retained', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mocks.findPaneOwningNode.mockReturnValueOnce({ pane: mocks.panes[0] })
    mocks.recordKeystroke.mockReturnValueOnce({ candidate: {}, unmatched: 1 })
    mocks.discardUndispatchedKeystroke.mockReturnValueOnce('counted-unmatched')
    installTypingLatencyDiagnostic()
    const bridge = (window as DiagnosticWindow).__orcaTypingDiagnostic
    if (!bridge || !mocks.inputListener) {
      throw new Error('Typing latency diagnostic did not start')
    }
    bridge.start()

    const registration = mocks.inputListener({
      event: new CustomEvent('xterm-composition-session-end'),
      source: 'ime',
      text: '한'
    })
    expect(bridge.report().sampling.unmatchedKeystrokes).toBe(1)
    registration?.settleAfterPropagation(true)

    expect(bridge.report()).toMatchObject({
      sampling: { unmatchedKeystrokes: 0 },
      byInputSource: {
        ime: { observedInputs: 0 },
        imeCommitChars: { count: 0 }
      }
    })
    bridge.stop()
  })
})
