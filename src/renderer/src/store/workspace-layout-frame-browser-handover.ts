import { noteStagedBrowserTabHandedToFrames } from '@/lib/staged-browser-frame-handover'

/** Only what the handover reads of the store's browser pages and their handles. */
type BrowserPages = {
  browserPagesByWorkspace: Readonly<Record<string, readonly { id: string }[] | undefined>>
}
type BrowserRecords = BrowserPages & {
  remoteBrowserPageHandlesByPageId: Readonly<
    Record<string, { environmentId: string; remotePageId: string; staged?: boolean } | undefined>
  >
}

/**
 * Records each staged browser tab of this desktop that a frame drops while drawing a server tab of
 * the same page in the same workspaces: the frames took the create over (L284). The frames' worktrees
 * are one server's, so the page id alone names the page.
 */
export function noteFramesTakingOverStagedBrowserTabs(
  state: BrowserRecords,
  built: BrowserPages,
  droppedTabIds: readonly string[],
  drawnTabIds: ReadonlySet<string>
): void {
  if (droppedTabIds.length === 0) {
    return
  }
  // A frame's page id is the server's page id, which the staged handle names as its remote id.
  const drawnPageIds = new Set(
    [...drawnTabIds].flatMap((tabId) =>
      (built.browserPagesByWorkspace[tabId] ?? []).map((page) => page.id)
    )
  )
  // Before scanning the dropped pages: a close drops many pages and draws none of a staged create's.
  if (
    !Object.values(state.remoteBrowserPageHandlesByPageId).some(
      (handle) => handle?.staged === true && drawnPageIds.has(handle.remotePageId)
    )
  ) {
    return
  }
  for (const tabId of droppedTabIds) {
    for (const page of state.browserPagesByWorkspace[tabId] ?? []) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (handle?.staged === true && drawnPageIds.has(handle.remotePageId)) {
        noteStagedBrowserTabHandedToFrames(tabId, handle.remotePageId)
      }
    }
  }
}
