import { useAppStore } from '@/store'
import { resolveBrowserSourceUnifiedTab } from './browser-workspace-source-resolution'

/** Opens `url` in a new Orca browser tab right after the page's tab, in the page's own profile. */
export function openUrlInTabBesideBrowserPage(args: {
  sourcePageId: string
  worktreeId: string
  url: string
  activate: boolean
}): void {
  const { sourcePageId, worktreeId, url, activate } = args
  const store = useAppStore.getState()
  const sourcePage = Object.values(store.browserPagesByWorkspace)
    .flat()
    .find((page) => page.id === sourcePageId)
  // Why: the new tab inherits the opener's cookie jar. Falling back to the default profile would let
  // a page in an isolated session hand its links to the default one, silently crossing profiles.
  const sourceTab = sourcePage
    ? (store.browserTabsByWorktree[worktreeId] ?? []).find(
        (tab) => tab.id === sourcePage.workspaceId
      )
    : undefined
  const sourceUnifiedTab = resolveBrowserSourceUnifiedTab(store, sourcePageId, worktreeId)
  store.createBrowserTab(worktreeId, url, {
    title: url,
    activate,
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
