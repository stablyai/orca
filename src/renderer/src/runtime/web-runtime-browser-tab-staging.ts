import { useAppStore } from '../store'

/** Local rows minted for a browser tab whose host create RPC has not answered yet. */
export type StagedWebRuntimeBrowserTab = {
  workspaceId: string
  pageId: string
  clientHosted: boolean
}

/**
 * Mint the local browser workspace/page/tab for a create that is still in flight, so the strip
 * shows the tab on click instead of after the host round-trip. The staged handle carries the
 * client-minted remote page id, which is what lets the host snapshot adopt these exact rows in
 * place (see findBrowserWorkspaceForRemotePage) rather than appending a second tab.
 */
export function stageWebRuntimeBrowserTab(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  url?: string
  title?: string
  profileId?: string | null
  targetGroupId?: string
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
    return { workspaceId: workspace.id, pageId, clientHosted: args.clientHosted === true }
  } catch (error) {
    // Why: staging is an optimization; a store-side refusal must not fail the create itself.
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

/**
 * Whether the staged tab is still in the strip. The workspace row is the signal: an adopting
 * snapshot takes over that same row, while the strip's cleanup close removes it — a distinction the
 * handle's staged flag cannot make, because adoption clears the flag too.
 */
export function isStagedWebRuntimeBrowserTabLive(
  staged: StagedWebRuntimeBrowserTab,
  worktreeId: string
): boolean {
  return (useAppStore.getState().browserTabsByWorktree[worktreeId] ?? []).some(
    (workspace) => workspace.id === staged.workspaceId
  )
}

/**
 * Which group the staged tab is in right now. The create asked for one group, but the user may
 * have moved the tab since; waiting for materialization in the group they left would stall the
 * create for the whole wait and then log a bogus "landed outside the requested group".
 */
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

/**
 * Point a staged tab at the page id the host actually minted, so the next snapshot adopts the
 * staged rows. Returns the still-staged tab, or null once it no longer needs tracking.
 */
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
    // Why: a snapshot already mirrored the host page under its own id while the create was in
    // flight; keeping the staged tab too would leave the user with two tabs for one page.
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

/**
 * Re-mark a staged tab once the live placement is known. Staging has to predict client hosting from
 * the renderer's cached runtime status, which can lag a runtime upgrade; without this the pane would
 * mount the component the stale verdict chose and swap only after adoption.
 */
export function restageWebRuntimeBrowserTabHostingIntent(
  staged: StagedWebRuntimeBrowserTab,
  args: { environmentId: string; remotePageId: string; clientHosted: boolean }
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

/**
 * Remove a staged tab that never materialized. Adopted tabs are left alone — by then the rows
 * belong to the host snapshot, and the caller's own tabClose owns retiring the host page.
 */
export function discardStagedWebRuntimeBrowserTab(staged: StagedWebRuntimeBrowserTab): void {
  const state = useAppStore.getState()
  if (state.remoteBrowserPageHandlesByPageId[staged.pageId]?.staged !== true) {
    return
  }
  // Why: drop the handle first so the cleanup close cannot dispatch a second browser.tabClose
  // for a page the create path is already retiring.
  state.removeRemoteBrowserPageHandle(staged.pageId)
  useAppStore.getState().closeBrowserTab(staged.workspaceId, { reason: 'cleanup' })
}
