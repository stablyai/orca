import { RUNTIME_CLIENT_WINDOW_WORKTREE_PARAM } from '../../../shared/runtime-client-window-fragment'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

const PARAM_PREFIX = `${RUNTIME_CLIENT_WINDOW_WORKTREE_PARAM}=`

type LaunchLocationHost = {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>
  history: Pick<History, 'state' | 'replaceState'>
}

/** The fragment without the launch-workspace parameter; every other segment stays byte-identical. */
export function withoutLaunchWorktreeParam(fragment: string): string {
  return fragment
    .split('&')
    .filter((segment) => !segment.startsWith(PARAM_PREFIX))
    .join('&')
}

/**
 * Takes the workspace the desktop asked this window to open (`#worktree=<id>`, beside a pairing
 * or alone) and drops it from the address bar, leaving the pairing fragment for its own cleanup.
 */
export function consumeLaunchWorktreeTarget(host: LaunchLocationHost = window): string | null {
  const fragment = host.location.hash.replace(/^#/, '')
  const remaining = withoutLaunchWorktreeParam(fragment)
  if (remaining === fragment) {
    return null
  }
  const worktreeId = new URLSearchParams(fragment).get(RUNTIME_CLIENT_WINDOW_WORKTREE_PARAM)
  // Why: a reload must not re-run the switch over whatever workspace the user picked since.
  host.history.replaceState(
    host.history.state,
    '',
    `${host.location.pathname}${host.location.search}${remaining ? `#${remaining}` : ''}`
  )
  return worktreeId?.trim() ? worktreeId : null
}

/**
 * Activates the launch workspace once this window's catalog has loaded, through the sidebar's
 * activation path so git worktrees and folder workspaces behave as if clicked.
 */
export async function activateLaunchWorktreeWhenReady(worktreeId: string): Promise<void> {
  // Why dynamic: this module runs before the app graph, which the web entry keeps out of its chunk.
  const [{ useAppStore }, { findFolderWorkspaceOwner }] = await Promise.all([
    import('@/store'),
    import('@/lib/folder-workspace-runtime-owner')
  ])
  if (!useAppStore.getState().startupWorktreeRefreshCompleted) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useAppStore.subscribe((state) => {
        if (state.startupWorktreeRefreshCompleted) {
          unsubscribe()
          resolve()
        }
      })
    })
  }
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(worktreeId)
  const known =
    scope?.type === 'folder'
      ? findFolderWorkspaceOwner(state, scope.folderWorkspaceId) !== null
      : Boolean(state.getKnownWorktreeById(worktreeId))
  if (!known) {
    console.warn(`[web] Launch workspace ${worktreeId} is not in this window's catalog; skipping.`)
    return
  }
  const { activateWorktreeFromSidebar } = await import('@/lib/sidebar-worktree-activation')
  await activateWorktreeFromSidebar(worktreeId)
}
