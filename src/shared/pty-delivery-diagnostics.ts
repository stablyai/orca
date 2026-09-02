/**
 * One-paste terminal freeze diagnostics: shared shapes for the breadcrumb
 * rings kept in BOTH processes and for the per-pty delivery table main embeds
 * in its debug snapshot. The goal is that a single console command captures
 * enough history + state to attribute any frozen-terminal report without
 * asking the user for more logs.
 */

export type PtyDeliveryBreadcrumb = {
  atMs: number
  kind: string
  detail?: Record<string, string | number | boolean | null>
  /** Same-kind events within the coalesce window fold into this counter. */
  repeats?: number
}

export type PtyDeliveryBreadcrumbRing = {
  record: (kind: string, detail?: PtyDeliveryBreadcrumb['detail']) => void
  snapshot: () => PtyDeliveryBreadcrumb[]
  reset: () => void
}

const BREADCRUMB_RING_CAPACITY = 100
const BREADCRUMB_COALESCE_MS = 1_000

// Why a ring with same-kind coalescing: breadcrumbs record rare transitions,
// but a pathological loop (marker flood, gate flapping) must cost one array
// slot + counter bump per second, never unbounded memory or GC churn.
export function createPtyDeliveryBreadcrumbRing(
  capacity = BREADCRUMB_RING_CAPACITY,
  coalesceMs = BREADCRUMB_COALESCE_MS
): PtyDeliveryBreadcrumbRing {
  let entries: PtyDeliveryBreadcrumb[] = []
  return {
    record(kind, detail) {
      const now = Date.now()
      const last = entries.at(-1)
      if (last && last.kind === kind && now - last.atMs < coalesceMs) {
        last.repeats = (last.repeats ?? 1) + 1
        last.atMs = now
        if (detail !== undefined) {
          last.detail = detail
        }
        return
      }
      entries.push(detail === undefined ? { atMs: now, kind } : { atMs: now, kind, detail })
      if (entries.length > capacity) {
        entries = entries.slice(entries.length - capacity)
      }
    },
    snapshot() {
      return entries.map((entry) => ({ ...entry }))
    },
    reset() {
      entries = []
    }
  }
}

// Why redact: daemon session ids embed worktree paths
// (`${worktreeId}@@${shortUuid}`). The `@@` suffix is unique enough to
// correlate a pty across the renderer/main sections of one report without
// shipping the user's filesystem layout.
export function redactPtyIdForDiagnostics(id: string): string {
  const separatorIdx = id.lastIndexOf('@@')
  if (separatorIdx !== -1) {
    return `…${id.slice(separatorIdx)}`
  }
  return id.length <= 12 ? id : `…${id.slice(-12)}`
}

export type PtyPerPtyDeliveryDiagnostics = {
  id: string
  sentChars: number
  ackedChars: number
  inFlightChars: number
  pendingChars: number
  hidden: boolean
  visible: boolean
  active: boolean
  msSinceLastSend: number | null
  msSinceLastAck: number | null
}

export type PtyMainDeliveryDiagnostics = {
  appVersion: string
  mainUptimeMs: number
  windowFocused: boolean | null
  windowVisible: boolean | null
  windowMinimized: boolean | null
  msSinceLastPowerSuspend: number | null
  msSinceLastPowerResume: number | null
  perPty: PtyPerPtyDeliveryDiagnostics[]
  breadcrumbs: PtyDeliveryBreadcrumb[]
}

export const EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS: PtyMainDeliveryDiagnostics = {
  appVersion: '',
  mainUptimeMs: 0,
  windowFocused: null,
  windowVisible: null,
  windowMinimized: null,
  msSinceLastPowerSuspend: null,
  msSinceLastPowerResume: null,
  perPty: [],
  breadcrumbs: []
}
