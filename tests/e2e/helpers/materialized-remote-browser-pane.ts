import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export type MaterializedRemoteBrowserPane = {
  /** The client's local browser page id — the key its remote handle is stored under. */
  pageId: string
  /** The client's local browser workspace (outer tab) id. */
  tabId: string
}

type RemoteBrowserPaneTarget = {
  environmentId: string
  remotePageId: string
  worktreeId: string
}

/**
 * Waits for the browser tab a paired client mirrors for a page the runtime created.
 *
 * Why wait for one instead of building one: the client materializes the host's browser tabs on its
 * own — workspace, page and remote handle included — so a locally created second row for the same
 * remote page is not a state a user can reach. It also breaks the stream, because the runtime keeps
 * exactly one screencast per connection: whichever pane subscribes last cancels the other's, and
 * the loser then strands on its own reconnect control.
 */
export async function waitForMaterializedRemoteBrowserPane(
  page: Page,
  target: RemoteBrowserPaneTarget
): Promise<MaterializedRemoteBrowserPane> {
  await expect
    .poll(() => page.evaluate(locateMaterializedPane, target), {
      timeout: 60_000,
      message: 'paired client never materialized a tab for the runtime-created browser page'
    })
    .not.toBeNull()
  const located = await page.evaluate(locateMaterializedPane, target)
  if (!located) {
    throw new Error('materialized remote browser tab disappeared before it could be used')
  }
  return located
}

/** Waits for that tab and then surfaces its pane, the way clicking the tab would. */
export async function focusMaterializedRemoteBrowserPane(
  page: Page,
  target: RemoteBrowserPaneTarget
): Promise<MaterializedRemoteBrowserPane> {
  const located = await waitForMaterializedRemoteBrowserPane(page, target)
  await page.evaluate(
    ({ tabId, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('client store unavailable')
      }
      state.setActiveWorktree(worktreeId)
      state.focusBrowserTabInWorktree(worktreeId, tabId, { surfacePane: true })
    },
    { tabId: located.tabId, worktreeId: target.worktreeId }
  )
  return located
}

/** Runs in the client renderer: the local rows carrying a handle to this runtime page. */
function locateMaterializedPane(
  target: RemoteBrowserPaneTarget
): MaterializedRemoteBrowserPane | null {
  const state = window.__store?.getState()
  if (!state) {
    return null
  }
  for (const workspace of state.browserTabsByWorktree[target.worktreeId] ?? []) {
    for (const pageId of workspace.pageIds ?? []) {
      const handle = state.remoteBrowserPageHandlesByPageId[pageId]
      if (
        handle?.environmentId === target.environmentId &&
        handle.remotePageId === target.remotePageId
      ) {
        return { pageId, tabId: workspace.id }
      }
    }
  }
  return null
}
