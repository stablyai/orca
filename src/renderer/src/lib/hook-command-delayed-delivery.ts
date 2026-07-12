import { useAppStore } from '@/store'

type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

type PendingWorktreeHookCommandDelivery = {
  worktreeId: string
  deliver: (state: AppStoreSnapshot, firstTerminalTabId: string) => void
}

// Why: runtime-owned worktrees mirror their session tabs asynchronously, so a
// fresh create usually has no tab to queue setup/issue commands on yet. Hold
// the delivery until the first mirrored terminal tab lands instead of
// dropping it. Mirrors agent-startup-delayed-delivery's lazy-subscription
// shape: subscribed only while something is pending.
const pendingHookCommandDeliveries = new Map<string, PendingWorktreeHookCommandDelivery>()
let unsubscribePendingHookCommandDeliveries: (() => void) | null = null

export function queueHookCommandsForFirstWorktreeTab(
  delivery: PendingWorktreeHookCommandDelivery
): void {
  pendingHookCommandDeliveries.set(delivery.worktreeId, delivery)
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
  // Capture references so unrelated PTY/status updates do not rescan every
  // runtime worktree waiting for its first mirrored terminal tab.
  let previousTabsByWorktree = initial.tabsByWorktree
  let previousWorktreesByRepo = initial.worktreesByRepo
  let previousDetectedWorktreesByRepo = initial.detectedWorktreesByRepo
  let previousFolderWorkspaces = initial.folderWorkspaces
  let previousWorktreeLookup = initial.getKnownWorktreeById
  unsubscribePendingHookCommandDeliveries = useAppStore.subscribe((state) => {
    // Why: only these slices (or the test-adapter lookup itself) can change
    // whether a pending worktree exists or has received its first tab.
    if (
      state.tabsByWorktree === previousTabsByWorktree &&
      state.worktreesByRepo === previousWorktreesByRepo &&
      state.detectedWorktreesByRepo === previousDetectedWorktreesByRepo &&
      state.folderWorkspaces === previousFolderWorkspaces &&
      state.getKnownWorktreeById === previousWorktreeLookup
    ) {
      return
    }
    previousTabsByWorktree = state.tabsByWorktree
    previousWorktreesByRepo = state.worktreesByRepo
    previousDetectedWorktreesByRepo = state.detectedWorktreesByRepo
    previousFolderWorkspaces = state.folderWorkspaces
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
  for (const [worktreeId, delivery] of pendingHookCommandDeliveries) {
    const firstTerminalTabId = state.tabsByWorktree[worktreeId]?.[0]?.id
    if (!firstTerminalTabId) {
      // Why: a worktree can be removed before its tabs ever mirror; drop the
      // entry so the subscription does not stay armed forever.
      if (!state.getKnownWorktreeById(worktreeId)) {
        pendingHookCommandDeliveries.delete(worktreeId)
      }
      continue
    }
    // Delete before delivering so store writes inside deliver cannot re-enter
    // this entry through the subscription.
    pendingHookCommandDeliveries.delete(worktreeId)
    delivery.deliver(state, firstTerminalTabId)
  }
  stopPendingHookCommandSubscriptionIfIdle()
}
