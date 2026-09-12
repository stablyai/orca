/** Where the caret sits in the address bar, in the shape `setSelectionRange` wants it back. */
export type BrowserAddressBarSelection = {
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
}

/** A highlighted suggestion standing in the input in place of what the user typed. */
export type BrowserAddressBarPreview = {
  /** The typed query the input showed before the preview replaced it; what Escape goes back to. */
  typedQuery: string
  /** The suggestion URL currently filling the input. */
  previewedUrl: string
}

/** An address-bar edit that was in progress when the chrome around it was torn down. */
export type BrowserAddressBarEditSession = {
  draft: string
  selection: BrowserAddressBarSelection
  suggestionsOpen: boolean
  /** Set only while a suggestion is being previewed, so the typed query is not lost with it. */
  preview: BrowserAddressBarPreview | null
}

// Why this exists outside React: adopting a client-hosted page swaps the streamed pane for the
// client-hosted one under a different key, so the whole address bar unmounts mid-typing. The page
// id is the one identity that survives that swap, so it keys what the remounting bar picks back up.
const editSessionsByPageId = new Map<string, BrowserAddressBarEditSession>()

export function saveBrowserAddressBarEditSession(
  pageId: string,
  session: BrowserAddressBarEditSession
): void {
  editSessionsByPageId.set(pageId, session)
  // Why a microtask rather than a timeout: React deletes the old pane and inserts the new one in
  // one synchronous commit, and the resuming layout effect runs before the stack unwinds — so a
  // swap always beats this. Anything arriving later is a different mount, such as a tab revisited
  // or a worktree switched back to, where seizing focus would be the bug rather than the fix.
  queueMicrotask(() => {
    if (editSessionsByPageId.get(pageId) === session) {
      editSessionsByPageId.delete(pageId)
    }
  })
}

export function consumeBrowserAddressBarEditSession(
  pageId: string
): BrowserAddressBarEditSession | null {
  const session = editSessionsByPageId.get(pageId) ?? null
  editSessionsByPageId.delete(pageId)
  return session
}

/**
 * Drop a page's parked edit. The microtask above already bounds every write to the commit that
 * made it, so this is hygiene rather than correctness: it keeps a closing page from leaving an
 * entry behind for the rest of the tick.
 */
export function clearBrowserAddressBarEditSession(pageId: string): void {
  editSessionsByPageId.delete(pageId)
}
