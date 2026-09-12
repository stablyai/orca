import { e2eConfig } from '@/lib/e2e-config'
import type { PtyBufferSnapshot } from '../pty-transport'
import type { PtyDataMeta } from '../pty-dispatcher'

type E2eTerminalPtyDataInjectionApi = {
  inject: (paneKey: string, data: string, meta?: PtyDataMeta) => boolean
  keys: () => string[]
}

type E2eTerminalPtyDataInjectionWindow = Window & {
  __terminalPtyDataInjection?: E2eTerminalPtyDataInjectionApi
  __terminalHiddenSnapshotOverride?: E2eTerminalHiddenSnapshotOverrideApi
}

const e2eTerminalPtyDataInjectors = new Map<string, (data: string, meta?: PtyDataMeta) => void>()

type InputDisposition =
  | 'entered'
  | 'replay'
  | 'stale'
  | 'locked'
  | 'quarantine'
  | 'sent'
  | 'rejected'
  | 'transport-flush'
  | 'transport-unavailable'
  | 'stream-submitted'
  | 'claim-queued'
  | 'claim-cleared'
  | 'claim-submitted'
  | 'claim-rejected'
  | 'unary-submitted'
  | 'unary-accepted'
  | 'unary-rejected'
  | 'unary-error'
type InputDispositionWindow = Window & {
  __terminalInputDisposition?: {
    begin: (paneId: number, ptyId?: string) => void
    finish: () => Partial<Record<InputDisposition, number>>
  }
}
let inputProbe: {
  paneId: number
  ptyId?: string
  counts: Partial<Record<InputDisposition, number>>
} | null = null

export function recordE2eTransportInputDisposition(
  ptyId: string | null,
  disposition: InputDisposition,
  codeUnits: number
): void {
  if (e2eConfig.exposeStore && ptyId && inputProbe?.ptyId === ptyId) {
    inputProbe.counts[disposition] = (inputProbe.counts[disposition] ?? 0) + codeUnits
  }
}

/** Opt-in counters only: no terminal data, identifiers, callbacks or retained sessions. */
export function recordE2eInputDisposition(paneId: number, disposition: InputDisposition): void {
  if (e2eConfig.exposeStore && inputProbe?.paneId === paneId) {
    inputProbe.counts[disposition] = (inputProbe.counts[disposition] ?? 0) + 1
  }
}

type E2eTerminalHiddenSnapshotOverrideApi = {
  setPending: (ptyId: string, snapshot: PtyBufferSnapshot) => void
  resolve: (ptyId: string) => void
  clear: (ptyId: string) => void
}

type E2eTerminalHiddenSnapshotOverride = {
  promise: Promise<PtyBufferSnapshot | null>
  resolve: () => void
}

const e2eTerminalHiddenSnapshotOverrides = new Map<string, E2eTerminalHiddenSnapshotOverride>()

// Why: the per-chunk hidden-skip grammar is deleted (Phase 6) — hidden bytes
// either never reach the renderer (delivery gate) or ride the background
// scheduler queue.
type E2eTerminalPtyOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
}

type E2eTerminalPtyOutputDebugApi = {
  reset: () => void
  snapshot: () => E2eTerminalPtyOutputDebugSnapshot
}

type E2eTerminalPtyOutputDebugWindow = Window & {
  __terminalPtyOutputDebug?: E2eTerminalPtyOutputDebugApi
}

const e2eTerminalPtyOutputDebugState: E2eTerminalPtyOutputDebugSnapshot = {
  hiddenRendererSkipCount: 0,
  hiddenRendererSkippedChars: 0
}

export function resetE2eTerminalPtyOutputDebug(): void {
  e2eTerminalPtyOutputDebugState.hiddenRendererSkipCount = 0
  e2eTerminalPtyOutputDebugState.hiddenRendererSkippedChars = 0
}

export function exposeE2eTerminalPtyOutputDebug(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as E2eTerminalPtyOutputDebugWindow
  ;(window as InputDispositionWindow).__terminalInputDisposition ??= {
    begin: (paneId, ptyId) => {
      inputProbe = { paneId, ptyId, counts: {} }
    },
    finish: () => {
      const counts = inputProbe?.counts ?? {}
      inputProbe = null
      return { ...counts }
    }
  }
  target.__terminalPtyOutputDebug ??= {
    reset: resetE2eTerminalPtyOutputDebug,
    snapshot: () => ({ ...e2eTerminalPtyOutputDebugState })
  }
}

export function recordHiddenRendererSkip(chars: number): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  exposeE2eTerminalPtyOutputDebug()
  e2eTerminalPtyOutputDebugState.hiddenRendererSkipCount += 1
  e2eTerminalPtyOutputDebugState.hiddenRendererSkippedChars += chars
}

export function exposeE2eTerminalPtyDataInjection(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  // Why: a real PTY can coalesce tiny TUI redraws before E2E sees them. This
  // e2e-only seam lets tests replay the renderer-side data callback exactly.
  const target = window as E2eTerminalPtyDataInjectionWindow
  target.__terminalPtyDataInjection ??= {
    inject: (paneKey, data, meta) => {
      const inject = e2eTerminalPtyDataInjectors.get(paneKey)
      if (!inject) {
        return false
      }
      inject(data, meta)
      return true
    },
    keys: () => [...e2eTerminalPtyDataInjectors.keys()]
  }
  target.__terminalHiddenSnapshotOverride ??= {
    setPending: (ptyId, snapshot) => {
      let resolve = (): void => {}
      const wait = new Promise<void>((nextResolve) => {
        resolve = nextResolve
      })
      e2eTerminalHiddenSnapshotOverrides.set(ptyId, {
        promise: wait.then(() => snapshot),
        resolve
      })
    },
    resolve: (ptyId) => {
      e2eTerminalHiddenSnapshotOverrides.get(ptyId)?.resolve()
    },
    clear: (ptyId) => {
      e2eTerminalHiddenSnapshotOverrides.delete(ptyId)
    }
  }
}

export function registerE2eTerminalPtyDataInjection(
  paneKey: string,
  inject: (data: string, meta?: PtyDataMeta) => void
): () => void {
  if (!e2eConfig.exposeStore) {
    return () => {}
  }
  exposeE2eTerminalPtyDataInjection()
  e2eTerminalPtyDataInjectors.set(paneKey, inject)
  return () => {
    if (e2eTerminalPtyDataInjectors.get(paneKey) === inject) {
      e2eTerminalPtyDataInjectors.delete(paneKey)
    }
  }
}

export function readE2eHiddenSnapshotOverride(
  ptyId: string
): Promise<PtyBufferSnapshot | null> | null {
  if (!e2eConfig.exposeStore) {
    return null
  }
  const override = e2eTerminalHiddenSnapshotOverrides.get(ptyId)
  if (!override) {
    return null
  }
  // Why: visual E2E needs to hold a hidden restore snapshot in flight so a
  // newer live TUI frame can race it deterministically.
  return override.promise.finally(() => {
    if (e2eTerminalHiddenSnapshotOverrides.get(ptyId) === override) {
      e2eTerminalHiddenSnapshotOverrides.delete(ptyId)
    }
  })
}
