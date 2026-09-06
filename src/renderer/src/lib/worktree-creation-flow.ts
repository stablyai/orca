import { useAppStore } from '@/store'
import {
  findPendingLinkedWorkItemCreationId,
  type WorktreeCreationPhase,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { executeWorktreeCreation } from '@/lib/worktree-creation-flow-execute'
import {
  getInitialWorktreeCreationPhase,
  getWorktreeCreationIndeterminate
} from '@/lib/worktree-creation-flow-startup'
import { retryStructuredWorktreeLaunch } from '@/lib/worktree-creation-structured-recovery'

type ContinueBackgroundWorktreeCreationOptions = {
  revealCreationSurface?: boolean
}

function revealPendingCreation(
  creationId: string,
  request: WorktreeCreationRequest,
  phase: WorktreeCreationPhase
): void {
  const store = useAppStore.getState()
  const indeterminate = getWorktreeCreationIndeterminate(request)
  store.beginPendingWorktreeCreation({
    creationId,
    phase,
    status: 'creating',
    startedAt: Date.now(),
    indeterminate,
    // Why: the creation surface owns the tab strip immediately. Delaying this
    // caused the real workspace tab bar to flash out when the debounce elapsed.
    loaderVisible: true,
    request
  })
  // Why: the creation panel only renders under the terminal view (App content
  // router), so force it active so the panel is what fills the content area.
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
}

/**
 * Kick off a worktree create in the background. The caller (the composer) has
 * already resolved every interactive decision into `request`, so this returns
 * immediately and the work outlives the now-closed modal. Progress and errors
 * surface on the pending creation's sidebar row and content panel.
 */
export function runBackgroundWorktreeCreation(request: WorktreeCreationRequest): string {
  const store = useAppStore.getState()
  const existingCreationId = findPendingLinkedWorkItemCreationId(
    store.pendingWorktreeCreations,
    request
  )
  if (existingCreationId) {
    store.setActivePendingWorktreeCreation(existingCreationId)
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
    return existingCreationId
  }
  // Why: crypto.randomUUID is undefined in non-secure browser contexts (LAN web
  // client over plain HTTP). createBrowserUuid falls back to getRandomValues.
  const creationId = createBrowserUuid()
  revealPendingCreation(creationId, request, getInitialWorktreeCreationPhase(request))
  void executeWorktreeCreation(creationId, request)
  return creationId
}

/** Stage a pending entry before async preflight so the UI shows immediate progress. */
export function beginBackgroundWorktreePreparation(request: WorktreeCreationRequest): string {
  const creationId = createBrowserUuid()
  revealPendingCreation(creationId, request, 'preparing')
  return creationId
}

/** Continue a staged pending entry once async preflight has produced a final request. */
export function continueBackgroundWorktreeCreation(
  creationId: string,
  request: WorktreeCreationRequest,
  options: ContinueBackgroundWorktreeCreationOptions = {}
): boolean {
  const store = useAppStore.getState()
  if (!store.pendingWorktreeCreations[creationId]) {
    return false
  }
  // Why: the remote/runtime create path emits no progress events, so the stepped
  // checklist would freeze on step 1. Use the request's captured repo owner so
  // Retry does not change shape when focus moves to another runtime.
  store.updatePendingWorktreeCreation(creationId, {
    phase: getInitialWorktreeCreationPhase(request),
    status: 'creating',
    startedAt: Date.now(),
    error: undefined,
    provisioningLog: undefined,
    request
  })
  // Why: background work-item preflight can finish after the user moved on; keep
  // the pending row alive without reselecting the creation panel in that case.
  if (options.revealCreationSurface !== false) {
    store.setActivePendingWorktreeCreation(creationId)
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
  }
  void executeWorktreeCreation(creationId, request)
  return true
}

/** Re-run a failed creation from its panel, reusing the captured request. */
export function retryBackgroundWorktreeCreation(creationId: string): void {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  if (!entry) {
    return
  }
  store.updatePendingWorktreeCreation(creationId, {
    status: 'creating',
    startedAt: Date.now(),
    phase:
      entry.request.ephemeralVmRecipe && !entry.request.ephemeralVmRuntimeId
        ? 'provisioning-vm'
        : 'fetching',
    error: undefined,
    provisioningLog: undefined
  })
  store.setActivePendingWorktreeCreation(creationId)
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
  if (entry.structuredLaunchRecoveryWorktreeId) {
    void retryStructuredWorktreeLaunch(
      creationId,
      entry.request,
      entry.structuredLaunchRecoveryWorktreeId
    )
    return
  }
  void executeWorktreeCreation(creationId, entry.request)
}
