import { useAppStore } from '../store'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  forgetDesktopCreatedServerTab,
  noteDesktopCreatedServerTab
} from '@/lib/desktop-created-server-tabs'

/** Local rows minted for a browser tab whose host create RPC has not answered yet. */
export type StagedWebRuntimeBrowserTab = {
  workspaceId: string
  pageId: string
  clientHosted: boolean
  /** Its tab-bar entry, once staging drew one. */
  tabId?: string
}

/** Stage before RPC for immediate tab display. The client-minted remote page ID lets findBrowserWorkspaceForRemotePage adopt these rows without a duplicate tab. */
export function stageWebRuntimeBrowserTab(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  url?: string
  title?: string
  profileId?: string | null
  targetGroupId?: string
  afterTabId?: string
  activate: boolean
  focusAddressBar?: boolean
  clientHosted?: boolean
}): StagedWebRuntimeBrowserTab | null {
  const state = useAppStore.getState()
  try {
    const workspace = state.createBrowserTab(args.worktreeId, args.url ?? 'about:blank', {
      activate: args.activate,
      browserPageId: args.remotePageId,
      browserRuntimeEnvironmentId: args.environmentId,
      // Use the paired owner, never the globally selected host.
      executionHostId: toRuntimeExecutionHostId(args.environmentId),
      ...(args.afterTabId ? { afterTabId: args.afterTabId } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.profileId !== undefined && args.profileId !== null
        ? { sessionProfileId: args.profileId }
        : {}),
      ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
      ...(args.focusAddressBar !== undefined ? { focusAddressBar: args.focusAddressBar } : {})
    })
    const pageId = useAppStore.getState().browserPagesByWorkspace[workspace.id]?.[0]?.id
    if (!pageId) {
      return null
    }
    useAppStore.getState().setRemoteBrowserPageHandle(pageId, {
      environmentId: args.environmentId,
      remotePageId: args.remotePageId,
      staged: true,
      ...(args.clientHosted ? { stagedClientHosted: true } : {})
    })
    const tabId = useAppStore
      .getState()
      .unifiedTabsByWorktree[args.worktreeId]?.find(
        (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
      )?.id
    const staged = {
      workspaceId: workspace.id,
      pageId,
      clientHosted: args.clientHosted === true,
      ...(tabId ? { tabId } : {})
    }
    holdStagedBrowserTab(args.environmentId, args.worktreeId, staged)
    return staged
  } catch (error) {
    // Staging is optional; store refusal must not fail creation.
    console.warn(
      '[web-runtime-session] failed to stage browser tab:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

/** The create was abandoned because the user closed the staged tab while it was still in flight. */
export class StagedWebRuntimeBrowserTabCancelledError extends Error {
  constructor() {
    super('The browser tab was closed before its create finished.')
    this.name = 'StagedWebRuntimeBrowserTabCancelledError'
  }
}

/** Workspace presence distinguishes adoption from staged X; both clear the staged flag, but only close removes the row. */
export function isStagedWebRuntimeBrowserTabLive(
  staged: StagedWebRuntimeBrowserTab,
  worktreeId: string
): boolean {
  return (useAppStore.getState().browserTabsByWorktree[worktreeId] ?? []).some(
    (workspace) => workspace.id === staged.workspaceId
  )
}

/** Follow staged tabs to their current group after a user move or materialization waits time out in the abandoned group. */
export function resolveStagedWebRuntimeBrowserTabGroupId(
  staged: StagedWebRuntimeBrowserTab,
  worktreeId: string
): string | undefined {
  return (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'browser' && tab.entityId === staged.workspaceId
  )?.groupId
}

function findWorkspaceIdForRemotePage(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
}): string | null {
  const state = useAppStore.getState()
  for (const workspace of state.browserTabsByWorktree[args.worktreeId] ?? []) {
    for (const page of state.browserPagesByWorkspace[workspace.id] ?? []) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (
        handle?.environmentId === args.environmentId &&
        handle.remotePageId === args.remotePageId
      ) {
        return workspace.id
      }
    }
  }
  return null
}

/** Rehome staging to the host-minted page ID for snapshot adoption; return null when tracking has ended. */
export function rehomeStagedWebRuntimeBrowserTab(
  staged: StagedWebRuntimeBrowserTab,
  args: { environmentId: string; worktreeId: string; remotePageId: string }
): StagedWebRuntimeBrowserTab | null {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId[staged.pageId]
  if (handle?.staged !== true) {
    return null
  }
  const mirrored = findWorkspaceIdForRemotePage(args)
  if (mirrored !== null && mirrored !== staged.workspaceId) {
    // Snapshot already mirrored this page under host IDs; keeping staging would duplicate it.
    discardStagedWebRuntimeBrowserTab(staged)
    return null
  }
  useAppStore.getState().setRemoteBrowserPageHandle(staged.pageId, {
    environmentId: args.environmentId,
    remotePageId: args.remotePageId,
    staged: true,
    ...(staged.clientHosted ? { stagedClientHosted: true } : {})
  })
  return staged
}

/** Restage from live placement when cached capabilities lag upgrades, avoiding a component swap at adoption. */
export function restageWebRuntimeBrowserTabHostingIntent(
  staged: StagedWebRuntimeBrowserTab,
  args: { environmentId: string; worktreeId: string; remotePageId: string; clientHosted: boolean }
): StagedWebRuntimeBrowserTab {
  if (staged.clientHosted === args.clientHosted) {
    return staged
  }
  const state = useAppStore.getState()
  if (state.remoteBrowserPageHandlesByPageId[staged.pageId]?.staged !== true) {
    return staged
  }
  state.setRemoteBrowserPageHandle(staged.pageId, {
    environmentId: args.environmentId,
    remotePageId: args.remotePageId,
    staged: true,
    ...(args.clientHosted ? { stagedClientHosted: true } : {})
  })
  return { ...staged, clientHosted: args.clientHosted }
}

const stagedTabIds = (staged: Pick<StagedWebRuntimeBrowserTab, 'workspaceId' | 'tabId'>) => [
  staged.workspaceId,
  ...(staged.tabId ? [staged.tabId] : [])
]

// Keep staging until server frames publish the page (L285); client-hosted pages never enter server layout (L274).
function holdStagedBrowserTab(
  environmentId: string,
  worktreeId: string,
  staged: StagedWebRuntimeBrowserTab
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  for (const id of stagedTabIds(staged)) {
    noteDesktopCreatedServerTab(environmentId, worktreeId, id)
  }
}

/** Once server layout lists the page, frames replace held/adopted staging with their own tab; in-flight creation reads that as handover (L284). */
export function releaseHeldBrowserTabsTheServerLists(
  environmentId: string,
  serverPageIdsByWorkspace: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const state = useAppStore.getState()
  const listed = [...serverPageIdsByWorkspace.values()]
  const pageIds = new Set(
    Object.entries(state.remoteBrowserPageHandlesByPageId).flatMap(([pageId, handle]) =>
      handle?.environmentId === environmentId && listed.some((ids) => ids.has(handle.remotePageId))
        ? [pageId]
        : []
    )
  )
  if (pageIds.size === 0) {
    return
  }
  for (const worktreeId of serverPageIdsByWorkspace.keys()) {
    for (const workspace of state.browserTabsByWorktree[worktreeId] ?? []) {
      if (!workspace.pageIds?.some((pageId) => pageIds.has(pageId))) {
        continue
      }
      const tabId = state.unifiedTabsByWorktree[worktreeId]?.find(
        (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
      )?.id
      for (const id of stagedTabIds({ workspaceId: workspace.id, ...(tabId ? { tabId } : {}) })) {
        forgetDesktopCreatedServerTab(id)
      }
    }
  }
}

/** Remove only unmaterialized staging; adopted rows belong to the snapshot and caller tabClose owns host cleanup. */
export function discardStagedWebRuntimeBrowserTab(staged: StagedWebRuntimeBrowserTab): void {
  const state = useAppStore.getState()
  if (state.remoteBrowserPageHandlesByPageId[staged.pageId]?.staged !== true) {
    return
  }
  // Drop handle first to prevent cleanup dispatching a duplicate browser.tabClose.
  state.removeRemoteBrowserPageHandle(staged.pageId)
  useAppStore.getState().closeBrowserTab(staged.workspaceId, { reason: 'cleanup' })
}
