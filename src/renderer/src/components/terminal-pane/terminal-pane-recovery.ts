import { useAppStore } from '@/store'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { locateTerminalTab } from '@/store/terminals/terminal-tab-location'
import {
  admitTerminalRecoveryRemount,
  captureTabRecoveryGeneration
} from '@/store/terminals/terminal-tab-recovery-ledger'
import type {
  TerminalRecoveryDecline,
  TerminalRecoveryRemountRequest,
  TerminalRecoveryRemountResult,
  TerminalRecoveryTrigger
} from '@/store/terminals/terminal-tab-recovery-ledger'
import type { TerminalPaneRecoveryReason } from '../../../../shared/terminal-tab-types'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine
} from './terminal-input-quarantine'

// Why this module exists: a terminal pane can die renderer-side while its PTY
// stays alive — a wedged xterm WriteBuffer (issue #2836), a disposed xterm
// still receiving writes, or a transport that lost its PTY binding across a
// remount race. Every pre-existing recovery path (dead-session reconcile,
// hibernation wake) gates on the PTY being dead, so these panes stayed
// fossils: last frame painted, every keystroke silently dropped, until the
// user reloaded the window (issue #8104 class). Recovery here reuses the
// proven remount seam — bumping the tab's generation unmounts TerminalPane,
// detach() preserves the live PTY, and the remounted pane builds a fresh
// xterm that reattaches and replays the daemon snapshot. No shell restart.
//
// The budget and the epoch live on the tab row (terminal-tab-recovery-ledger),
// not in maps keyed by tabId here. Only the mounted-xterm registry below is
// still module-level: an xterm instance genuinely outlives no store row, so it
// has nothing to shadow.

export type { TerminalPaneRecoveryReason }

type RecoveryRequest = {
  tabId: string
  ptyId: string | null
  reason: TerminalPaneRecoveryReason
  /** Identifies the tab recovery epoch making the request. A successful
   *  recovery must immediately invalidate every pre-remount request. */
  terminalRecoveryGeneration?: number
  /** Identifies the concrete mounted xterm making the request. Disposal
   *  invalidates delayed work even when the tab's recovery epoch is unchanged. */
  terminalRecoveryInstanceId?: number
  /** Defaults to 'automatic'. 'user' marks the explicit Retry in the error
   *  toast, which is itself the new trigger a settled failure waits for. */
  trigger?: TerminalRecoveryTrigger
  /** Remote panes (runtime mirrors, app-SSH) must prove the PTY alive before
   *  an input-undeliverable remount: pty:hasPty answers null for ids the local
   *  registry doesn't own, and treating null as "proceed" would let a
   *  disconnected remote pane churn reconnects on every cooldown window. That
   *  churn needs a *disconnected* pane, which is why 'input-rejected-by-host'
   *  is exempt: its evidence arrives over a live connection. */
  requireAuthoritativeLiveness?: boolean
  /** The provider rejected the write because its endpoint stopped accepting
   *  writes, so re-attach MAY land on a *fresh* shell (a respawn; a transient
   *  socket drop reconnects to the same sessions). Only this path can mangle the
   *  in-flight line, and only it may quarantine input — a recovery that always
   *  keeps the same live shell would have a legitimate command eaten. */
  endpointReplaced?: boolean
}

const activeTerminalRecoveryInstanceIds = new Set<number>()
const pendingRetryByTabId = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>
    requestsByInstanceId: Map<number | undefined, RecoveryRequest>
  }
>()
let nextTerminalRecoveryInstanceId = 0

function toRemountRequest(request: RecoveryRequest, now: number): TerminalRecoveryRemountRequest {
  return {
    reason: request.reason,
    trigger: request.trigger ?? 'automatic',
    ...(request.terminalRecoveryGeneration === undefined
      ? {}
      : { generation: request.terminalRecoveryGeneration }),
    now
  }
}

function shouldScheduleRecoveryRetry(
  request: RecoveryRequest,
  decline: TerminalRecoveryDecline
): decline is Extract<TerminalRecoveryDecline, { retryInMs: number }> {
  if (decline.declinedBy === 'cooldown') {
    return request.terminalRecoveryGeneration !== undefined
  }
  if (decline.declinedBy === 'unsettled') {
    // A pane that never reports leaves 'pending' standing; re-asking once the
    // settlement bound elapses is how that tab gets a second chance at all.
    return request.terminalRecoveryGeneration !== undefined
  }
  if (decline.declinedBy === 'window-cap') {
    return request.reason !== 'reattach-unverifiable'
  }
  // 'settled-failure' deliberately schedules nothing: a retry timer would be
  // the counting loop again. Only a new trigger reopens that reason.
  return false
}

export function captureTerminalPaneRecoveryGeneration(tabId: string): number {
  const state = useAppStore.getState()
  return captureTabRecoveryGeneration(locateTerminalTab(state.tabsByWorktree, tabId)?.tab)
}

export function registerTerminalPaneRecoveryInstance(tabId: string): {
  id: number
  unregister: () => void
} {
  const id = ++nextTerminalRecoveryInstanceId
  activeTerminalRecoveryInstanceIds.add(id)
  return {
    id,
    unregister: () => {
      activeTerminalRecoveryInstanceIds.delete(id)
      const pendingRetry = pendingRetryByTabId.get(tabId)
      pendingRetry?.requestsByInstanceId.delete(id)
      if (pendingRetry?.requestsByInstanceId.size === 0) {
        cancelPendingRecoveryRetry(tabId)
      }
      // No budget release here, by construction: the ledger is a field on the
      // tab row, so closing the tab drops it and nothing else can. Releasing it
      // from a pane disposal is what erased every consumed remount and let the
      // cap lapse (crash b5cfc6ca).
    }
  }
}

function isCurrentTerminalRecoveryRequest(request: RecoveryRequest): boolean {
  return (
    (request.terminalRecoveryGeneration === undefined ||
      request.terminalRecoveryGeneration ===
        captureTerminalPaneRecoveryGeneration(request.tabId)) &&
    (request.terminalRecoveryInstanceId === undefined ||
      activeTerminalRecoveryInstanceIds.has(request.terminalRecoveryInstanceId))
  )
}

function scheduleRecoveryRetry(request: RecoveryRequest, delayMs: number): void {
  if (!isCurrentTerminalRecoveryRequest(request)) {
    return
  }
  const pendingRetry = pendingRetryByTabId.get(request.tabId)
  if (pendingRetry) {
    // Multiple split panes share a tab-wide remount. Keep one request per
    // concrete xterm so disposing one pane cannot cancel a sibling's heal.
    pendingRetry.requestsByInstanceId.set(request.terminalRecoveryInstanceId, request)
    return
  }
  const requestsByInstanceId = new Map<number | undefined, RecoveryRequest>([
    [request.terminalRecoveryInstanceId, request]
  ])
  const timer = setTimeout(
    () => {
      pendingRetryByTabId.delete(request.tabId)
      const currentRequests = [...requestsByInstanceId.values()].filter(
        isCurrentTerminalRecoveryRequest
      )
      if (currentRequests.length === 0) {
        return
      }
      // Why: one split's liveness probe may fail or never settle while a
      // sibling has a probe-certified dead renderer. Start every current
      // request so the first valid remount wins and invalidates the rest.
      void Promise.all(
        currentRequests.map((currentRequest) => requestTerminalPaneRecovery(currentRequest))
      )
    },
    Math.max(delayMs, 1_000)
  )
  pendingRetryByTabId.set(request.tabId, {
    timer,
    requestsByInstanceId
  })
}

function cancelPendingRecoveryRetry(tabId: string): void {
  const pendingRetry = pendingRetryByTabId.get(tabId)
  if (pendingRetry !== undefined) {
    clearTimeout(pendingRetry.timer)
    pendingRetryByTabId.delete(tabId)
  }
}

function handleDeclinedRecovery(request: RecoveryRequest, decline: TerminalRecoveryDecline): false {
  if (decline.declinedBy === 'window-cap') {
    // The backstop firing means the outcome gate let a loop through. That is a
    // bug in the gate, so leave a trace rather than only declining quietly.
    recordRendererCrashBreadcrumb('terminal_pane_recovery_window_cap', {
      tabId: request.tabId,
      reason: request.reason
    })
  }
  if (shouldScheduleRecoveryRetry(request, decline)) {
    scheduleRecoveryRetry(request, decline.retryInMs)
  }
  return false
}

/**
 * Remount the pane's tab to rebuild its renderer over the live PTY. Returns
 * true when a remount was actually requested.
 *
 * For 'input-undeliverable' the PTY is liveness-checked first: a dead PTY is
 * the dead-session reconcile's job (it tears down and reports "Process
 * exited"), and remounting there would race it. 'input-rejected-by-host' skips
 * that probe — see the reason's declaration. Nothing here destroys a session
 * either way: a remount rebuilds the renderer over the PTY it already had.
 */
export async function requestTerminalPaneRecovery(request: RecoveryRequest): Promise<boolean> {
  if (
    request.terminalRecoveryInstanceId !== undefined &&
    !activeTerminalRecoveryInstanceIds.has(request.terminalRecoveryInstanceId)
  ) {
    return false
  }
  const state = useAppStore.getState()
  const tab = locateTerminalTab(state.tabsByWorktree, request.tabId)?.tab
  // A terminal-backed tab is intentionally hidden while native chat owns the
  // provider. Late xterm callbacks from that hidden surface must not remount
  // the tab and race the handoff's owner transition.
  //
  // Both indices, deliberately. The row is now the durable record (viewMode
  // persists on it, and the local toggles patch it in the same set() as the
  // unified tab), but a session written before that lives on disk with viewMode
  // only on the unified tab, so the row reads undefined on the first load after
  // upgrade. More generally this is a disjunction over two partly-redundant
  // sources for a SAFETY check: a hole in either index errs toward refusing a
  // heal on a hidden surface, never toward remounting a chat-owned one.
  if (tab?.viewMode === 'chat' || state.getTab?.(request.tabId)?.viewMode === 'chat') {
    return false
  }
  // Fail fast before the liveness probe. The authoritative admission runs
  // again inside remountTerminalTabForRecovery's write.
  const admission = admitTerminalRecoveryRemount(tab, toRemountRequest(request, Date.now()))
  if (!admission.admitted) {
    if (admission.declinedBy === 'stale-generation') {
      return false
    }
    // 'tab-missing' deliberately falls through: the store call below is what
    // records the remount-unavailable breadcrumb for a vanished tab.
    if (admission.declinedBy !== 'tab-missing') {
      return handleDeclinedRecovery(request, admission)
    }
  }
  // 'input-rejected-by-host' is deliberately absent: no local probe can speak
  // for the id it carries, and its evidence already came from the PTY's owner.
  if (request.reason === 'input-undeliverable') {
    if (!request.ptyId) {
      return false
    }
    try {
      const live = await window.api.pty.hasPty(request.ptyId)
      if (live === false) {
        return false
      }
      if (request.requireAuthoritativeLiveness && live !== true) {
        return false
      }
    } catch {
      if (request.requireAuthoritativeLiveness) {
        return false
      }
      // Liveness unknown (IPC hiccup) on a local pane: proceed — a remount
      // over a dead PTY degrades to the existing dead-pane rendering, not a
      // broken state.
    }
  }
  let result: TerminalRecoveryRemountResult
  try {
    result = useAppStore
      .getState()
      .remountTerminalTabForRecovery(request.tabId, toRemountRequest(request, Date.now()))
  } catch {
    // Why: recovery fires from timer and write-callback contexts (stall watch,
    // replay guard, onData) — it is best-effort by contract and must never
    // surface a throw there (partial store surfaces in tests, teardown races).
    // The breadcrumb is the only trace of a production failure loop here: the
    // budget was not consumed, so the detector will retry each cooldown.
    // recordRendererCrashBreadcrumb is itself guarded and cannot throw.
    recordRendererCrashBreadcrumb('terminal_pane_recovery_failed', {
      tabId: request.tabId,
      reason: request.reason
    })
    return false
  }
  if (!result.remounted) {
    if (result.declinedBy === 'tab-missing') {
      // Why: this was the one silent outcome — the tab is gone from the store
      // (closed/orphaned), so retrying is pointless, but the trace must show
      // that a certified-dead pane asked for recovery and none happened.
      recordRendererCrashBreadcrumb('terminal_pane_recovery_remount_unavailable', {
        tabId: request.tabId,
        reason: request.reason
      })
      return false
    }
    return result.declinedBy === 'stale-generation'
      ? false
      : handleDeclinedRecovery(request, result)
  }
  // A remount replaces every pane xterm in the tab; a previously scheduled
  // retry would only re-remount the fresh, healthy panes.
  cancelPendingRecoveryRetry(request.tabId)
  if (request.endpointReplaced) {
    // Why here and not at request time: arming before the remount is certain
    // would suppress input on a pane that never recovered.
    armTerminalInputQuarantine(request.tabId)
  }
  // warn, not error: this is the recovery succeeding, and the breadcrumb below is
  // what diagnostics actually read. STA-2373 made this path routine (every daemon
  // death remounts each live pane), so error level just floods the logs.
  console.warn(
    `[terminal] recovering pane tab ${request.tabId} — ${request.reason} with a live PTY (${request.ptyId ?? 'unbound'}); remounting to rebuild the renderer`
  )
  recordRendererCrashBreadcrumb('terminal_pane_recovery_remount', {
    tabId: request.tabId,
    reason: request.reason
  })
  return true
}

/** Report what this mounted pane observed for the recovery epoch it captured.
 *  Reuses the direct-SSH pane retry vocabulary so a pane settles both ledgers
 *  from the same call sites. Ignored unless the epoch is still current. */
export function settleTerminalPaneRecovery(
  tabId: string,
  generation: number | undefined,
  outcome: 'success' | 'failed' | 'timed-out' | 'superseded'
): void {
  if (generation === undefined) {
    return
  }
  useAppStore.getState().settleTerminalTabRecovery?.(tabId, generation, outcome)
}

export function _resetTerminalPaneRecoveryForTests(): void {
  activeTerminalRecoveryInstanceIds.clear()
  nextTerminalRecoveryInstanceId = 0
  for (const pendingRetry of pendingRetryByTabId.values()) {
    clearTimeout(pendingRetry.timer)
  }
  pendingRetryByTabId.clear()
  _resetTerminalInputQuarantineForTests()
}
