import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { showBrowserOpenFailure } from '@/lib/browser/workspace/workspace-browser-open-failure-toast'

/** The card's linked issue or review, opened in the workspace's own browser. */
export function openLinkedUrlInWorkspaceBrowser(worktreeId: string, url: string): Promise<void> {
  return openWorkspaceBrowserTab({ workspaceId: worktreeId, url, intent: { kind: 'url' } }).then(
    () => undefined,
    showBrowserOpenFailure
  )
}
