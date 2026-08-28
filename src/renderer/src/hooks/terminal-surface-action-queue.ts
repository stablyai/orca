import type { AppState } from '../store/types'

const TERMINAL_SURFACE_ACTION_TIMEOUT_MS = 9_000

export type TerminalSurfaceActionCancellationReason =
  | 'action-failed'
  | 'cancelled'
  | 'ipc-events-disposed'
  | 'surface-unmounted'
  | 'tab-removed'
  | 'timeout'

export type TerminalSurfaceActionCallbacks = {
  onConsumed?: () => void
  onCancelled?: (reason: TerminalSurfaceActionCancellationReason, error?: unknown) => void
}

type PendingTerminalSurfaceAction = {
  tabId: string
  action: () => void
  callbacks: TerminalSurfaceActionCallbacks
  timeoutId: ReturnType<typeof setTimeout> | null
  settled: boolean
}

const terminalSurfaceConsumerCountByTabId = new Map<string, number>()
const pendingTerminalSurfaceActionsByTabId = new Map<string, Set<PendingTerminalSurfaceAction>>()

function invokeTerminalSurfaceSettlement(callback: () => void): void {
  try {
    callback()
  } catch {
    // Why: the action outcome is already final; a reply failure must not
    // reclassify success as cancellation or strand consumer cleanup.
  }
}

function removePendingTerminalSurfaceAction(pending: PendingTerminalSurfaceAction): void {
  const tabActions = pendingTerminalSurfaceActionsByTabId.get(pending.tabId)
  tabActions?.delete(pending)
  if (tabActions?.size === 0) {
    pendingTerminalSurfaceActionsByTabId.delete(pending.tabId)
  }
}

function consumeTerminalSurfaceAction(pending: PendingTerminalSurfaceAction): void {
  if (pending.settled) {
    return
  }
  pending.settled = true
  removePendingTerminalSurfaceAction(pending)
  if (pending.timeoutId !== null) {
    globalThis.clearTimeout(pending.timeoutId)
  }
  try {
    pending.action()
  } catch (error) {
    invokeTerminalSurfaceSettlement(() => pending.callbacks.onCancelled?.('action-failed', error))
    return
  }
  invokeTerminalSurfaceSettlement(() => pending.callbacks.onConsumed?.())
}

function cancelTerminalSurfaceAction(
  pending: PendingTerminalSurfaceAction,
  reason: TerminalSurfaceActionCancellationReason
): void {
  if (pending.settled) {
    return
  }
  pending.settled = true
  removePendingTerminalSurfaceAction(pending)
  if (pending.timeoutId !== null) {
    globalThis.clearTimeout(pending.timeoutId)
  }
  invokeTerminalSurfaceSettlement(() => pending.callbacks.onCancelled?.(reason))
}

export function queueTerminalSurfaceAction(
  tabId: string,
  action: () => void,
  callbacks: TerminalSurfaceActionCallbacks = {}
): () => void {
  if ((terminalSurfaceConsumerCountByTabId.get(tabId) ?? 0) > 0) {
    try {
      action()
    } catch (error) {
      invokeTerminalSurfaceSettlement(() => callbacks.onCancelled?.('action-failed', error))
      return () => undefined
    }
    invokeTerminalSurfaceSettlement(() => callbacks.onConsumed?.())
    return () => undefined
  }

  const pending: PendingTerminalSurfaceAction = {
    tabId,
    action,
    callbacks,
    timeoutId: null,
    settled: false
  }
  pending.timeoutId = globalThis.setTimeout(() => {
    cancelTerminalSurfaceAction(pending, 'timeout')
  }, TERMINAL_SURFACE_ACTION_TIMEOUT_MS)
  const tabActions = pendingTerminalSurfaceActionsByTabId.get(tabId) ?? new Set()
  tabActions.add(pending)
  pendingTerminalSurfaceActionsByTabId.set(tabId, tabActions)
  return () => cancelTerminalSurfaceAction(pending, 'cancelled')
}

export function cancelPendingTerminalSurfaceActions(
  tabId: string,
  reason: TerminalSurfaceActionCancellationReason
): void {
  const pending = [...(pendingTerminalSurfaceActionsByTabId.get(tabId) ?? [])]
  for (const action of pending) {
    cancelTerminalSurfaceAction(action, reason)
  }
}

export function registerTerminalSurfaceActionConsumer(tabId: string): () => void {
  terminalSurfaceConsumerCountByTabId.set(
    tabId,
    (terminalSurfaceConsumerCountByTabId.get(tabId) ?? 0) + 1
  )
  for (const pending of pendingTerminalSurfaceActionsByTabId.get(tabId) ?? []) {
    consumeTerminalSurfaceAction(pending)
  }

  let registered = true
  return () => {
    if (!registered) {
      return
    }
    registered = false
    const nextCount = (terminalSurfaceConsumerCountByTabId.get(tabId) ?? 1) - 1
    if (nextCount > 0) {
      terminalSurfaceConsumerCountByTabId.set(tabId, nextCount)
      return
    }
    terminalSurfaceConsumerCountByTabId.delete(tabId)
    cancelPendingTerminalSurfaceActions(tabId, 'surface-unmounted')
  }
}

export function hasTerminalSurfaceActionConsumer(tabId: string): boolean {
  return (terminalSurfaceConsumerCountByTabId.get(tabId) ?? 0) > 0
}

export function cancelAllPendingTerminalSurfaceActions(
  reason: TerminalSurfaceActionCancellationReason
): void {
  for (const tabId of pendingTerminalSurfaceActionsByTabId.keys()) {
    cancelPendingTerminalSurfaceActions(tabId, reason)
  }
}

export function cancelTerminalSurfaceActionsForRemovedTabs(
  state: Pick<AppState, 'tabsByWorktree'>
): void {
  if (pendingTerminalSurfaceActionsByTabId.size === 0) {
    return
  }
  const liveTabIds = new Set(
    Object.values(state.tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  for (const tabId of pendingTerminalSurfaceActionsByTabId.keys()) {
    if (!liveTabIds.has(tabId)) {
      cancelPendingTerminalSurfaceActions(tabId, 'tab-removed')
    }
  }
}
