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
import { notifyTerminalInputNotSent } from './terminal-input-not-sent-notice'

// Renderer death can leave the PTY alive; remount rebuilds xterm and reattaches/replays without restarting the shell (#2836, #8104). Store budget/epoch on the durable tab row, with only concrete xterm registration module-local.

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
  /** Remote input-undeliverable recovery needs owner-proven liveness; local unknowns cannot permit disconnected churn. Live owner write rejection already proves contact and skips this gate. */
  requireAuthoritativeLiveness?: boolean
  /** Write rejection can mean a fresh replacement shell; only that uncertainty permits quarantining an interrupted command suffix. Same-shell recovery must preserve typing. */
  endpointReplaced?: boolean
  /** Read just before an endpoint-replaced remount: some pane holds input its host never
   *  applied, which the remount discards. */
  hasUndeliveredInput?: () => boolean
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
    // Aged pending permits another bounded attempt because some fresh-spawn panes never report an outcome.
    return request.terminalRecoveryGeneration !== undefined
  }
  if (decline.declinedBy === 'window-cap') {
    // Why: a host that keeps contradicting itself must stop at the cap and leave the pane ended.
    return (
      request.reason !== 'reattach-unverifiable' && request.reason !== 'host-rebound-exited-pane'
    )
  }
  // Settled failure schedules no timer; only a new trigger can reopen it without recreating the loop.
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
      // Only closing the tab drops its row-ledger budget; pane-disposal release previously erased every remount’s cost (b5cfc6ca).
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
    // Deduplicate per concrete xterm; a sibling’s disposal cannot cancel another pane’s heal.
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
      // Start sibling probes independently; one hung probe cannot block a certified-dead renderer’s recovery.
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
    // Cap firing means the outcome gate admitted a loop; preserve that diagnostic signal.
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

/** Remount over the existing PTY and return whether requested. Probe input-undeliverable first so dead-session teardown owns actual process death; owner-certified write rejection needs no local probe. */
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
  // Fail before probing, then recheck authoritative admission inside the store write.
  const admission = admitTerminalRecoveryRemount(tab, toRemountRequest(request, Date.now()))
  if (!admission.admitted) {
    if (admission.declinedBy === 'stale-generation') {
      return false
    }
    // Let missing tabs reach the store call that records remount-unavailable evidence.
    if (admission.declinedBy !== 'tab-missing') {
      return handleDeclinedRecovery(request, admission)
    }
  }
  // Owner write rejection already proves contact; local probes cannot speak for these PTY IDs.
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
      // Local liveness uncertainty permits remount; a dead PTY still falls back to existing exited-pane rendering.
    }
  }
  // Why before the remount: it retires the transports that know what was typed.
  const undeliveredInput = request.endpointReplaced && request.hasUndeliveredInput?.() === true
  let result: TerminalRecoveryRemountResult
  try {
    result = useAppStore
      .getState()
      .remountTerminalTabForRecovery(request.tabId, toRemountRequest(request, Date.now()))
  } catch {
    // Best-effort timer/write-callback recovery must not throw; breadcrumb failures because unconsumed budgets can retry each cooldown.
    recordRendererCrashBreadcrumb('terminal_pane_recovery_failed', {
      tabId: request.tabId,
      reason: request.reason
    })
    return false
  }
  if (!result.remounted) {
    if (result.declinedBy === 'tab-missing') {
      // Vanished tabs cannot recover, but retain evidence that a certified-dead pane requested it.
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
  // Tab remount replaces every xterm; cancel retries that would remount healthy replacements.
  cancelPendingRecoveryRetry(request.tabId)
  if (request.endpointReplaced) {
    // Arm quarantine only after confirmed remount or a refused recovery would suppress valid input.
    armTerminalInputQuarantine(request.tabId)
    if (undeliveredInput) {
      notifyTerminalInputNotSent(request.tabId)
    }
  }
  // Warn for routine successful daemon-death recovery; error would flood logs, while breadcrumbs carry diagnosis (STA-2373).
  console.warn(
    `[terminal] recovering pane tab ${request.tabId} — ${request.reason} with a live PTY (${request.ptyId ?? 'unbound'}); remounting to rebuild the renderer`
  )
  recordRendererCrashBreadcrumb('terminal_pane_recovery_remount', {
    tabId: request.tabId,
    reason: request.reason
  })
  return true
}

/** Settle the captured epoch only while current; reuse SSH retry outcomes so both ledgers settle from the same call sites. */
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
