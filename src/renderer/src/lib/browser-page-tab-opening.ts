import { useAppStore } from '@/store'
import { findPage, findWorkspace } from '@/store/slices/browser-page-records'
import { redactKagiSessionToken } from '../../../shared/browser-url'
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
  const sourcePage = findPage(store.browserPagesByWorkspace, sourcePageId)
  // Why: inherit the opener's cookie jar; the default profile would silently cross profiles.
  const sourceTab = sourcePage
    ? findWorkspace(store.browserTabsByWorktree, sourcePage.workspaceId)
    : null
  const sourceUnifiedTab = resolveBrowserSourceUnifiedTab(store, sourcePageId, worktreeId)
  store.createBrowserTab(worktreeId, url, {
    // Why: a Kagi private-session search URL carries a token; only the stored URL is redacted.
    title: redactKagiSessionToken(url),
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
