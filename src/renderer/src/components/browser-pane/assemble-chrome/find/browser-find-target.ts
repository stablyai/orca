export type BrowserFindResultEvent = {
  result: { requestId: number; activeMatchOrdinal: number; matches: number }
}

/** What the find bar drives: a local webview, or a streamed page whose host runs the search. */
export type BrowserFindTarget = {
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number
  stopFindInPage(action: 'clearSelection'): void
  addEventListener(type: 'found-in-page', listener: (event: BrowserFindResultEvent) => void): void
  removeEventListener(
    type: 'found-in-page',
    listener: (event: BrowserFindResultEvent) => void
  ): void
}
