import type { AppState } from '@/store/types'
import { clearBrowserAddressBarEditSession } from '@/components/browser-pane/assemble-chrome/browser-address-bar-edit-session'
import { clearBrowserPageDeferredNavigation } from '@/components/browser-pane/navigate/browser-page-deferred-navigation'
import { destroyWorkspaceWebviews } from '@/store/slices/browser-webview-cleanup'
import { useAppStore } from '@/store'
import {
  collectPendingClientHostedBrowserCloses,
  type PendingClientHostedBrowserClose
} from './client-hosted-browser-close-intents'
import { getBrowserWorkspaceRemoteOwnerEnvironmentIds } from './remote-browser-tab-ownership'
import {
  planBrowserWorkspaceTabClose,
  type BrowserWorkspaceTabClosePlan
} from './browser-workspace-tab-close-plan'
import { closeWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from './web-runtime-session-environment'

/** All user close paths share runtime ownership policy here; divergent strip/menu/bulk handling once skipped pageless mirrors and left the X inert. */
export function closeBrowserWorkspaceTabOnHosts({
  state,
  worktreeId,
  workspaceId,
  visibleTabId,
  focusedEnvironmentId
}: {
  state: Pick<
    AppState,
    | 'browserPagesByWorkspace'
    | 'remoteBrowserPageHandlesByPageId'
    | 'recordClientHostedBrowserCloseIntents'
  >
  worktreeId: string
  workspaceId: string
  /** The tab id the host knows this mirror by. */
  visibleTabId: string
  focusedEnvironmentId: string | null | undefined
}): BrowserWorkspaceTabClosePlan {
  const plan = planBrowserWorkspaceTabClose({
    state,
    workspaceId,
    focusedEnvironmentId,
    isEnvironmentActive: isWebRuntimeSessionActive
  })
  // Every user close releases parked half-typed/submitted URLs. Staged rollback and shutdownWorktreeBrowsers bypass this funnel and rely on registry microtask/TTL/unique-ID bounds.
  for (const page of state.browserPagesByWorkspace[workspaceId] ?? []) {
    clearBrowserAddressBarEditSession(page.id)
    clearBrowserPageDeferredNavigation(page.id)
  }
  // Capture owners before teardown drops their handles or the durable close intent loses its targets.
  const pending = collectPendingClientHostedBrowserCloses(state, {
    workspaceId,
    worktreeId,
    environmentIds:
      plan.hostEnvironmentIds.length > 0
        ? plan.hostEnvironmentIds.filter((id): id is string => id !== null)
        : getBrowserWorkspaceRemoteOwnerEnvironmentIds(state, workspaceId)
  })
  if (plan.closesLocally) {
    // Local teardown with all owners unreachable needs durable intent: runtimes persist client-hosted pages and otherwise resurrect the dismissed tab on restart.
    state.recordClientHostedBrowserCloseIntents(pending)
    return plan
  }
  void settleBrowserWorkspaceTabCloseOnHosts({
    plan,
    worktreeId,
    workspaceId,
    visibleTabId,
    pending,
    // Capture stable actions now; settlement outlives this tab snapshot.
    recordCloseIntents: state.recordClientHostedBrowserCloseIntents
  })
  return plan
}

async function settleBrowserWorkspaceTabCloseOnHosts(args: {
  plan: BrowserWorkspaceTabClosePlan
  worktreeId: string
  workspaceId: string
  visibleTabId: string
  pending: readonly PendingClientHostedBrowserClose[]
  recordCloseIntents: (closes: readonly PendingClientHostedBrowserClose[]) => void
}): Promise<void> {
  const outcomes = await Promise.all(
    args.plan.hostEnvironmentIds.map(async (environmentId) => ({
      environmentId,
      outcome: await closeWebRuntimeSessionTab({
        worktreeId: args.worktreeId,
        tabId: args.visibleTabId,
        environmentId,
        reason: 'user'
      })
    }))
  )
  const unheard = new Set(
    outcomes.filter((entry) => entry.outcome === 'failed').map((entry) => entry.environmentId)
  )
  args.recordCloseIntents(args.pending.filter((close) => unheard.has(close.environmentId)))
  // Remove locally only when every owner definitively forgot the tab; any remaining owner retracts through sync, and local teardown would race it.
  if (
    !args.plan.removesVisibleTab &&
    outcomes.length > 0 &&
    outcomes.every((entry) => entry.outcome === 'unknown-tab')
  ) {
    tearDownBrowserWorkspaceTabLocally(args.worktreeId, args.workspaceId)
  }
}

function tearDownBrowserWorkspaceTabLocally(worktreeId: string, workspaceId: string): void {
  const state = useAppStore.getState()
  if (!(state.browserTabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === workspaceId)) {
    return
  }
  // Close before guest teardown so MRU fallback uses announced selection, not registration order (#16306).
  state.closeBrowserTab(workspaceId)
  destroyWorkspaceWebviews(state.browserPagesByWorkspace, workspaceId)
  // Re-read after closeBrowserTab: it usually removes the mirror, and a later occupant must not be closed.
  const mirroredTab = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.contentType === 'browser' && candidate.entityId === workspaceId
  )
  if (mirroredTab) {
    useAppStore.getState().closeUnifiedTab(mirroredTab.id)
  }
}
