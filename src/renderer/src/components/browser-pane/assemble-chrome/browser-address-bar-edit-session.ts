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

// Page identity survives streamed/client-hosted pane swaps; park live edits outside React for the replacement bar.
const editSessionsByPageId = new Map<string, BrowserAddressBarEditSession>()

export function saveBrowserAddressBarEditSession(
  pageId: string,
  session: BrowserAddressBarEditSession
): void {
  editSessionsByPageId.set(pageId, session)
  // Expire after this synchronous commit: layout effects may resume a swap, but later revisits must never seize focus.
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

/** Clear a closing page’s parked edit before the microtask expires it. */
export function clearBrowserAddressBarEditSession(pageId: string): void {
  editSessionsByPageId.delete(pageId)
}
