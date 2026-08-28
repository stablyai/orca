/**
 * One-paste typing-latency self-diagnostic:
 *
 *   window.__orcaTypingDiagnostic.start()   // then type normally for ~20s
 *   window.__orcaTypingDiagnostic.report()  // logs + returns a JSON-safe object
 *   window.__orcaTypingDiagnostic.stop()
 *
 * Why: keystroke-echo lag reproduces on one user's machine only, so the
 * measurement has to run THERE. The census answers what a user cannot: agent-row
 * scale, store listener count, suspect settings, and which agent/screen mode the
 * focused pane is in.
 *
 * Nothing attaches to the keystroke path until start(); stop() detaches all of it.
 */
import {
  countMountedAgentRows,
  readFocusedPaneCensus,
  readProbeStoreState,
  readStoreListenerCount
} from './typing-latency-census-probe'
import {
  detachPaneEcho,
  findPaneOwningFocus,
  instrumentPaneEcho,
  listProbePanes,
  recordKeystroke,
  type InstrumentedPane
} from './typing-latency-echo-instrumentation'
import {
  summarizeLatencySamples,
  summarizeTypingScaleCensus,
  type LatencyPercentiles,
  type TypingScaleCensus
} from './typing-latency-diagnostic-summary'
import {
  createInputSourceTally,
  emptyInputSourceBreakdown,
  type InputSourceBreakdown,
  type InputSourceTally
} from './typing-latency-input-source'
import {
  watchMainThreadBlocking,
  type MainThreadBlockingCensus,
  type MainThreadBlockingWatch
} from './typing-latency-main-thread-blocking'

/** Bounds memory during sustained typing: percentiles only need a rolling window. */
const MAX_SAMPLES = 2000

type ProbeState = {
  startedAt: number
  startedAtIso: string
  parseLatencies: number[]
  paintLatencies: number[]
  keystrokeBytes: number[]
  keystrokeWrites: number[]
  unmatchedKeystrokes: number
  keystrokesWithoutTerminalFocus: number
  panes: InstrumentedPane[]
  detachKeydown: () => void
  blocking: MainThreadBlockingWatch
  bySource: InputSourceTally
}

let active: ProbeState | null = null
let lastState: ProbeState | null = null
let cachedAppVersion: string | null = null

function push(values: number[], value: number): void {
  values.push(value)
  if (values.length > MAX_SAMPLES) {
    values.shift()
  }
}

export type TypingLatencyReport = {
  capturedAt: string
  sampling: {
    running: boolean
    startedAt: string | null
    durationMs: number | null
    keystrokesWithoutTerminalFocus: number
    unmatchedKeystrokes: number
    instrumentedPanes: number
  }
  echoParseMs: LatencyPercentiles
  echoPaintMs: LatencyPercentiles
  bytesPerKeystroke: LatencyPercentiles
  writesPerKeystroke: LatencyPercentiles
  /** Same latencies split by IME commit vs plain keypress. */
  byInputSource: InputSourceBreakdown
  /** How much of the sampling window the renderer had no free main thread. */
  mainThreadBlocking: MainThreadBlockingCensus
  census: TypingScaleCensus
}

function buildReport(state: ProbeState | null, running: boolean): TypingLatencyReport {
  return {
    capturedAt: new Date().toISOString(),
    sampling: {
      running,
      startedAt: state?.startedAtIso ?? null,
      durationMs: state ? Math.round(performance.now() - state.startedAt) : null,
      keystrokesWithoutTerminalFocus: state?.keystrokesWithoutTerminalFocus ?? 0,
      unmatchedKeystrokes: state?.unmatchedKeystrokes ?? 0,
      instrumentedPanes: state?.panes.length ?? 0
    },
    echoParseMs: summarizeLatencySamples(state?.parseLatencies ?? []),
    echoPaintMs: summarizeLatencySamples(state?.paintLatencies ?? []),
    bytesPerKeystroke: summarizeLatencySamples(state?.keystrokeBytes ?? []),
    writesPerKeystroke: summarizeLatencySamples(state?.keystrokeWrites ?? []),
    byInputSource: state?.bySource.breakdown() ?? emptyInputSourceBreakdown(),
    mainThreadBlocking: state?.blocking.census() ?? {
      supported: false,
      windowMs: 0,
      taskCount: 0,
      blockedMs: 0,
      blockedPercent: 0,
      longestTaskMs: 0,
      p50TaskMs: 0,
      p95TaskMs: 0
    },
    census: summarizeTypingScaleCensus({
      state: readProbeStoreState(),
      appVersion: cachedAppVersion,
      livePaneCount: listProbePanes().length,
      instrumentedPaneCount: state?.panes.length ?? 0,
      mountedAgentRowCount: countMountedAgentRows(),
      storeListenerCount: readStoreListenerCount(),
      focusedPane: readFocusedPaneCensus()
    })
  }
}

function cacheAppVersion(): void {
  void window.api?.updater
    ?.getVersion?.()
    .then((version) => {
      cachedAppVersion = version
    })
    .catch(() => undefined)
}

/**
 * Modifier-only presses produce no echo and would poison the pending queue.
 * IME keydowns are excluded too: a composing jamo sends nothing to the pty, so
 * the commit (compositionend) is what carries the echo — see startProbe.
 */
function isEchoingKey(event: KeyboardEvent): boolean {
  if (event.isComposing || event.key === 'Process') {
    return false
  }
  return event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace'
}

function startProbe(): string {
  if (active) {
    return 'Typing diagnostic already running. Type for ~20s, then run __orcaTypingDiagnostic.report().'
  }
  cacheAppVersion()

  const state: ProbeState = {
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    parseLatencies: [],
    paintLatencies: [],
    keystrokeBytes: [],
    keystrokeWrites: [],
    unmatchedKeystrokes: 0,
    keystrokesWithoutTerminalFocus: 0,
    panes: [],
    detachKeydown: () => undefined,
    blocking: watchMainThreadBlocking(),
    bySource: createInputSourceTally()
  }
  state.panes = listProbePanes().map((pane) =>
    instrumentPaneEcho(pane, (sample) => {
      push(state.parseLatencies, sample.parseMs)
      push(state.paintLatencies, sample.paintMs)
      push(state.keystrokeBytes, sample.bytes)
      push(state.keystrokeWrites, sample.writes)
      state.bySource.add(sample)
    })
  )

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isEchoingKey(event)) {
      return
    }
    const target = findPaneOwningFocus(state.panes)
    if (!target) {
      state.keystrokesWithoutTerminalFocus += 1
      return
    }
    state.unmatchedKeystrokes += recordKeystroke(target, performance.now(), 'direct')
  }
  // Why: a CJK IME sends nothing to the pty per jamo, so the composed commit is
  // the keystroke whose echo can be timed. Without this the probe reports zero
  // samples for Hangul typing and the percentiles read as "no latency".
  const onCompositionEnd = (event: CompositionEvent): void => {
    if (event.data.length === 0) {
      return
    }
    const target = findPaneOwningFocus(state.panes)
    if (!target) {
      state.keystrokesWithoutTerminalFocus += 1
      return
    }
    // Array.from, not .length: a supplementary-plane commit is two UTF-16 units
    // but one character, and this counts characters per commit.
    state.bySource.addCommitChars(Array.from(event.data).length)
    state.unmatchedKeystrokes += recordKeystroke(target, performance.now(), 'ime')
  }
  window.addEventListener('keydown', onKeydown, { capture: true })
  window.addEventListener('compositionend', onCompositionEnd, { capture: true })
  state.detachKeydown = () => {
    window.removeEventListener('keydown', onKeydown, { capture: true })
    window.removeEventListener('compositionend', onCompositionEnd, { capture: true })
  }

  active = state
  lastState = state
  return `Typing diagnostic started on ${state.panes.length} pane(s). Click into the agent terminal, type normally for ~20 seconds, then run __orcaTypingDiagnostic.report().`
}

function stopProbe(): string {
  const state = active
  if (!state) {
    return 'Typing diagnostic was not running.'
  }
  active = null
  state.detachKeydown()
  state.blocking.stop()
  for (const entry of state.panes) {
    detachPaneEcho(entry)
  }
  return 'Typing diagnostic stopped. Run __orcaTypingDiagnostic.report() to read the last samples.'
}

function reportProbe(): TypingLatencyReport {
  const report = buildReport(active ?? lastState, active !== null)
  console.log('[orca] typing latency diagnostic', report)
  return report
}

export type TypingDiagnosticBridge = {
  start: () => string
  stop: () => string
  report: () => TypingLatencyReport
}

type TypingDiagnosticWindow = Window & { __orcaTypingDiagnostic?: TypingDiagnosticBridge }

export function installTypingLatencyDiagnostic(): void {
  if (typeof window === 'undefined') {
    return
  }
  const target = window as TypingDiagnosticWindow
  if (target.__orcaTypingDiagnostic) {
    return
  }
  target.__orcaTypingDiagnostic = { start: startProbe, stop: stopProbe, report: reportProbe }
}
