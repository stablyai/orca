import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

export const TERMINAL_STARTUP_TIMING_KEY = 'orca:terminal-startup-timing'
type Disposable = { dispose(): void }
type Phase = 'connected' | 'liveData' | 'submitted' | 'writeStarted' | 'parsed' | 'renderEvent'
type Finish = 'observed' | 'timeout' | 'disposed' | 'replaced' | 'error'
type WriteTiming = { beforeWrite(): void; onParsed(): void }

export type TerminalStartupTiming = {
  mark(phase: Phase): void
  firstWrite(): WriteTiming | undefined
  finish(outcome: Finish): void
}

export function createTerminalStartupTiming(options: {
  paneKey: string
  generation: number
  getPtyId(): string | null
  isCurrent(): boolean
  isForeground(): boolean
  onRender(callback: () => void): Disposable
}): TerminalStartupTiming | undefined {
  try {
    if (localStorage.getItem(TERMINAL_STARTUP_TIMING_KEY) !== '1') {
      return undefined
    }
  } catch {
    return undefined
  }
  const started = performance.now()
  const phases: Partial<Record<Phase, number>> = {}
  let observedPtyId: string | null = null
  let ended = false
  let writeClaimed = false
  let renderSubscription: Disposable | undefined
  const timeout = setTimeout(() => finish('timeout'), 10_000)

  function finish(outcome: Finish): void {
    if (ended) {
      return
    }
    ended = true
    clearTimeout(timeout)
    try {
      renderSubscription?.dispose()
    } catch {
      // Optional diagnostics cannot interrupt terminal cleanup.
    }
    try {
      recordRendererCrashBreadcrumb('terminal_startup_timing', {
        paneKey: options.paneKey,
        generation: options.generation,
        ptyId: observedPtyId,
        outcome,
        foreground: options.isForeground(),
        documentVisible: document.visibilityState === 'visible',
        elapsedMs: performance.now() - started,
        ...phases
      })
    } catch {
      // A disappearing transport must not make diagnostic completion fail.
    }
  }
  function mark(phase: Phase): void {
    if (ended || !options.isCurrent() || phases[phase] !== undefined) {
      return
    }
    if ((phase === 'connected' || phase === 'liveData') && observedPtyId === null) {
      try {
        observedPtyId = options.getPtyId()
      } catch {
        // Preserve an unknown identity when the current transport cannot report it.
      }
    }
    phases[phase] = performance.now() - started
    if (
      phases.connected !== undefined &&
      phases.parsed !== undefined &&
      phases.renderEvent !== undefined
    ) {
      finish('observed')
    }
  }
  return {
    mark,
    finish,
    firstWrite() {
      if (ended || writeClaimed || !options.isCurrent()) {
        return undefined
      }
      writeClaimed = true
      mark('submitted')
      return {
        beforeWrite() {
          if (ended || !options.isCurrent() || phases.writeStarted !== undefined) {
            return
          }
          mark('writeStarted')
          // The public event reports xterm activity, not physical display presentation.
          try {
            renderSubscription = options.onRender(() => mark('renderEvent'))
          } catch {
            finish('error')
          }
        },
        onParsed() {
          mark('parsed')
        }
      }
    }
  }
}
