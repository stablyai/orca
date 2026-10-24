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
    // Why: following an HTML file link changes which worktree is foregrounded,
    // so it must record a history visit before opening the browser tab — but the
    // browser tab is the surface, so an emptied workspace must not gain a shell.
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
