import { useAppStore } from '@/store/index'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser/workspace/browser-workspace-source-resolution'
import type { RemoteBrowserPaneNotice } from './remote-browser-page-input-model'

export function openRemoteBrowserLinkInNewTab({
  url,
  activate,
  browserPageId,
  worktreeId,
  runtimeEnvironmentId,
  setPaneNotice
}: {
  url: string
  activate: boolean
  browserPageId: string
  worktreeId: string
  runtimeEnvironmentId: string
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}): void {
  const sourceUnifiedTab = resolveBrowserSourceUnifiedTab(
    useAppStore.getState(),
    browserPageId,
    worktreeId
  )
  void openWorkspaceBrowserTab({
    workspaceId: worktreeId,
    url,
    ...(sourceUnifiedTab ? { afterTabId: sourceUnifiedTab.id } : {}),
    focusOnCreate: activate,
    selectWorktree: false,
    intent: { kind: 'url' },
    expectedRuntimeEnvironmentId: runtimeEnvironmentId,
    placementPreference: 'server'
  }).catch((error) => {
    setPaneNotice({
      kind: 'direct',
      text: error instanceof Error ? error.message : String(error)
    })
  })
}
