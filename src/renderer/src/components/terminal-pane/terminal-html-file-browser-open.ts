import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'

/** Renders a linked local HTML file in an Orca browser tab of the workspace. */
export function openHtmlFileInBrowser(
  filePath: string,
  worktreeId: string,
  clientLocal: boolean
): void {
  const store = useAppStore.getState()
  if (worktreeId) {
    // Record the foreground workspace visit before opening; reveal without seeding a shell because the browser is its surface.
    activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
  }
  const fileUrl = absolutePathToFileUri(filePath)
  const title = filePath.split(/[/\\]/).pop() ?? filePath
  store.createBrowserTab(worktreeId, fileUrl, {
    title,
    activate: true,
    // Why: the file is on this computer, so the workspace's paired-server runtime must not adopt the page.
    ...(clientLocal ? { browserRuntimeEnvironmentId: null } : {})
  })
}
