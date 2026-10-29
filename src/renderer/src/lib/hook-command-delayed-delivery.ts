import { useAppStore } from '@/store'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

type PendingWorktreeHookCommandDelivery = {
  worktreeId: string
  deliver: (state: AppStoreSnapshot, firstTerminalTabId: string) => void
}

// Hold deliveries until the first asynchronously mirrored terminal; queue multiple entries per workspace so hook commands and agent seeds coexist. Subscribe only while pending.
const pendingHookCommandDeliveries = new Map<string, PendingWorktreeHookCommandDelivery[]>()
let unsubscribePendingHookCommandDeliveries: (() => void) | null = null

export function queueHookCommandsForFirstWorktreeTab(
  delivery: PendingWorktreeHookCommandDelivery
): void {
  const queued = pendingHookCommandDeliveries.get(delivery.worktreeId)
  if (queued) {
    queued.push(delivery)
  } else {
    pendingHookCommandDeliveries.set(delivery.worktreeId, [delivery])
  }
  ensurePendingHookCommandSubscription()
  flushPendingHookCommandDeliveries()
}

export function resetHookCommandDelayedDeliveryForTests(): void {
  pendingHookCommandDeliveries.clear()
  unsubscribePendingHookCommandDeliveries?.()
  unsubscribePendingHookCommandDeliveries = null
}

function ensurePendingHookCommandSubscription(): void {
  if (unsubscribePendingHookCommandDeliveries) {
    return
  }
  const initial = useAppStore.getState()
  // Track references so unrelated PTY/status writes cannot rescan all pending runtime workspaces.
  let previousTabsByWorktree = initial.tabsByWorktree
  let previousWorktreesByRepo = selectWorktreesByRepo(initial)
  let previousDetectedWorktreesByRepo = selectDetectedWorktreesByRepo(initial)
  let previousFolderWorkspaces = selectFolderWorkspaces(initial)
  let previousWorktreeLookup = initial.getKnownWorktreeById
  unsubscribePendingHookCommandDeliveries = useAppStore.subscribe((state) => {
    // Only these slices/adapter lookup can change workspace existence or first-tab availability.
    if (
      state.tabsByWorktree === previousTabsByWorktree &&
      selectWorktreesByRepo(state) === previousWorktreesByRepo &&
      selectDetectedWorktreesByRepo(state) === previousDetectedWorktreesByRepo &&
      selectFolderWorkspaces(state) === previousFolderWorkspaces &&
      state.getKnownWorktreeById === previousWorktreeLookup
    ) {
      return
    }
    previousTabsByWorktree = state.tabsByWorktree
    previousWorktreesByRepo = selectWorktreesByRepo(state)
    previousDetectedWorktreesByRepo = selectDetectedWorktreesByRepo(state)
    previousFolderWorkspaces = selectFolderWorkspaces(state)
    previousWorktreeLookup = state.getKnownWorktreeById
    flushPendingHookCommandDeliveries()
  })
}

function stopPendingHookCommandSubscriptionIfIdle(): void {
  if (pendingHookCommandDeliveries.size > 0 || !unsubscribePendingHookCommandDeliveries) {
    return
  }
  unsubscribePendingHookCommandDeliveries()
  unsubscribePendingHookCommandDeliveries = null
}

function flushPendingHookCommandDeliveries(): void {
  const state = useAppStore.getState()
  for (const [worktreeId, deliveries] of pendingHookCommandDeliveries) {
    const firstTerminalTabId = state.tabsByWorktree[worktreeId]?.[0]?.id
    if (!firstTerminalTabId) {
      // Drop removed workspaces so pending entries cannot hold the subscription forever.
      if (!state.getKnownWorktreeById(worktreeId)) {
        pendingHookCommandDeliveries.delete(worktreeId)
      }
      continue
    }
    // Remove before calling deliver: synchronous store writes can re-enter this subscription.
    pendingHookCommandDeliveries.delete(worktreeId)
    for (const delivery of deliveries) {
      delivery.deliver(state, firstTerminalTabId)
    }
  }
  stopPendingHookCommandSubscriptionIfIdle()
}
