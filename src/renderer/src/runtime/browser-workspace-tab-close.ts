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
import { closeWebRuntimeSessionTab, isWebRuntimeSessionActive } from './web-runtime-session'

/**
 * The one place a browser workspace's tab is closed on the runtimes that own it. Every close entry
 * point (tab strip, tab-group menu, bulk close) goes through here so none of them can grow its own
 * ownership policy — a divergent one silently skipped the pageless host mirror and left the X inert.
 */
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
  // Why here: chrome the user was mid-way through — a half-typed URL, a URL submitted against a
  // page the host had not minted yet — is parked outside React under the page id, waiting for the
  // pane that owns it, and this funnel is where every user-driven close of that pane lands. The two
  // teardowns that bypass the funnel by design (the staged-create rollback, shutdownWorktreeBrowsers)
  // leave the entries to the registries' own bounds: a microtask fence, a TTL, and unique page ids.
  for (const page of state.browserPagesByWorkspace[workspaceId] ?? []) {
    clearBrowserAddressBarEditSession(page.id)
    clearBrowserPageDeferredNavigation(page.id)
  }
  // Collected before anything tears down: the handles this reads are exactly what the teardown
  // drops, so a later read would see a workspace with no owners and record nothing.
  const pending = collectPendingClientHostedBrowserCloses(state, {
    workspaceId,
    worktreeId,
    environmentIds:
      plan.hostEnvironmentIds.length > 0
        ? plan.hostEnvironmentIds.filter((id): id is string => id !== null)
        : getBrowserWorkspaceRemoteOwnerEnvironmentIds(state, workspaceId)
  })
  if (plan.closesLocally) {
    // Why: this renderer only promotes itself to owner when every owning host is unreachable, so
    // the close is one none of them heard. The runtime persists client-hosted pages, so without a
    // durable intent its next start faithfully restores the tab the user just dismissed.
    state.recordClientHostedBrowserCloseIntents(pending)
    return plan
  }
  void settleBrowserWorkspaceTabCloseOnHosts({
    plan,
    worktreeId,
    workspaceId,
    visibleTabId,
    pending,
    // Captured rather than re-read: store actions are stable, and the settle resolves long after
    // this snapshot stops describing the tab.
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
  // Why every owner and not any: a host that still knows the page removes this mirror through tab
  // sync, and tearing down here too would race that retraction. Only when all of them answer that
  // the tab does not exist is there nobody left to do it — the case the connected-owner branch
  // could not see, which left the X inert against a host that had forgotten the page.
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
  // Why before the teardown: closeBrowserTab announces the MRU page selection, and a guest torn
  // down first leaves the fallback picking registration order instead (#16306).
  state.closeBrowserTab(workspaceId)
  destroyWorkspaceWebviews(state.browserPagesByWorkspace, workspaceId)
  // Read after: closeBrowserTab normally removes the mirror itself, and looking it up again is what
  // keeps this from closing whatever tab later took its place.
  const mirroredTab = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.contentType === 'browser' && candidate.entityId === workspaceId
  )
  if (mirroredTab) {
    useAppStore.getState().closeUnifiedTab(mirroredTab.id)
  }
}
