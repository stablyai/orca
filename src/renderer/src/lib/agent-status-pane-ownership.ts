import type { AppState } from '../store/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { collectLeafIdsInOrder } from '../components/terminal-pane/terminal-layout-leaf-ids'
import { getIndexedRepoMap, getIndexedWorktreeMap } from '../store/worktree-repo-index'

/** Resolve a paneKey (tabId:leafId) to liveness, current title, owning worktree,
 *  and the owning repo's connectionId. Used for agent-type inference and to drop
 *  status updates for torn-down tabs or dead connections (an SSH reconnect retires the
 *  old connectionId, so events still in flight under it must not land). */
export function resolvePaneKey(
  store: AppState,
  paneKey: string
): {
  exists: boolean
  title: string | undefined
  identityTitle: string | undefined
  repoConnectionId: string | null
  repoConnectionResolved: boolean
  owningWorktreeId: string | undefined
  titleUsesTabTitle: boolean
  /** The tab record's own title, which is the slot the hook-driven tab write actually overwrites. */
  tabTitle: string | undefined
} {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined,
      titleUsesTabTitle: false,
      tabTitle: undefined
    }
  }
  const { tabId, leafId } = parsed
  const layout = store.terminalLayoutsByTabId?.[tabId]
  let exists = false
  let tabTitle: string | undefined
  let unifiedTabLabel: string | undefined
  let owningWorktreeId: string | undefined
  for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.id === tabId) {
        exists = true
        tabTitle = tab.title
        owningWorktreeId = worktreeId
        const visibleTab = (store.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
          (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
        )
        const rawVisibleLabel = visibleTab?.label?.trim()
        unifiedTabLabel =
          rawVisibleLabel && rawVisibleLabel.length > 0 ? rawVisibleLabel : undefined
        break
      }
    }
    if (exists) {
      break
    }
  }
  // Why: keep "resolved to a local repo" distinct from "not hydrated yet" so callers filter strictly post-hydration but still accept SSH snapshots during the startup ownership gap.
  let repoConnectionId: string | null = null
  let repoConnectionResolved = false
  if (owningWorktreeId !== undefined) {
    const worktree = getIndexedWorktreeMap(store.worktreesByRepo).get(owningWorktreeId)
    if (worktree) {
      const repo = getIndexedRepoMap(store.repos).get(worktree.repoId)
      repoConnectionResolved = repo !== undefined
      repoConnectionId = repo?.connectionId ?? null
    }
  }
  if (!exists) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId,
      titleUsesTabTitle: false,
      tabTitle: undefined
    }
  }
  // Why: an empty layout snapshot from a worktree switch (tab/PTY still live) counts as missing metadata; a non-empty layout lacking the leaf still means closed.
  const leafExists = layout?.root ? collectLeafIdsInOrder(layout.root).includes(leafId) : true
  if (!leafExists) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId,
      titleUsesTabTitle: false,
      tabTitle: undefined
    }
  }
  // Why: inactive worktrees can have a durable tab and live PTY while the layout is unmounted; hook state must still land there.
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  // Why: treat empty-string paneTitle as "no title" so the tab-level fallback fires; nullish-coalescing on '' would short-circuit and erase cached terminalTitle.
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  return {
    exists,
    title: paneTitle ?? tabTitle,
    // Why: some agents (OpenClaude) keep the terminal title generic while the tab label carries the agent identity; use only the non-custom label for attribution.
    identityTitle: paneTitle ?? unifiedTabLabel ?? tabTitle,
    repoConnectionId,
    repoConnectionResolved,
    owningWorktreeId,
    titleUsesTabTitle: paneTitle === undefined,
    tabTitle
  }
}

export function resolveWorktreeConnection(
  store: AppState,
  worktreeId: string
): {
  worktreeExists: boolean
  repoConnectionId: string | null
  repoConnectionResolved: boolean
} {
  const worktree = getIndexedWorktreeMap(store.worktreesByRepo).get(worktreeId)
  if (!worktree) {
    return { worktreeExists: false, repoConnectionId: null, repoConnectionResolved: false }
  }
  const repo = getIndexedRepoMap(store.repos).get(worktree.repoId)
  return {
    worktreeExists: true,
    repoConnectionId: repo?.connectionId ?? null,
    repoConnectionResolved: repo !== undefined
  }
}
