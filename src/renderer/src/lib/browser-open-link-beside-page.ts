import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser-workspace-source-resolution'

/** The page, when it belongs to a local worktree this desktop can open tabs in. */
function findLocalBrowserPage(state: AppState, browserPageId: string) {
  const page = Object.values(state.browserPagesByWorkspace)
    .flat()
    .find((candidate) => candidate.id === browserPageId)
  return page && !getRuntimeEnvironmentIdForWorktree(state, page.worktreeId) ? page : null
}

export function canOpenLinkBesideBrowserPage(state: AppState, browserPageId: string): boolean {
  return findLocalBrowserPage(state, browserPageId) !== null
}

/** Opens a URL in a new browser tab beside a page, in that page's worktree and profile. */
export function openLinkBesideBrowserPage(
  browserPageId: string,
  url: string,
  activate?: boolean
): void {
  const store = useAppStore.getState()
  const sourcePage = findLocalBrowserPage(store, browserPageId)
  if (!sourcePage) {
    return
  }
  // Why: the link inherits the opener's cookie jar. Falling back to the default profile would let
  // a page in an isolated session hand its links to the default one, silently crossing profiles.
  const sourceTab = (store.browserTabsByWorktree[sourcePage.worktreeId] ?? []).find(
    (tab) => tab.id === sourcePage.workspaceId
  )
  const sourceUnifiedTab = resolveBrowserSourceUnifiedTab(
    store,
    browserPageId,
    sourcePage.worktreeId
  )
  store.createBrowserTab(sourcePage.worktreeId, url, {
    title: url,
    activate: activate ?? true,
    ...(sourceUnifiedTab ? { afterTabId: sourceUnifiedTab.id } : {}),
    ...(sourceUnifiedTab?.executionHostId
      ? { executionHostId: sourceUnifiedTab.executionHostId }
      : {}),
    ...(sourceTab
      ? {
          sessionProfileId: sourceTab.sessionProfileId,
          sessionPartition: sourceTab.sessionPartition
        }
      : {})
  })
}
