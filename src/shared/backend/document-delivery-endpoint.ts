/** One renderer document as application code sees it: identity, liveness and delivery, no native objects. */
export type DocumentDeliveryEndpoint = {
  /** The hosting view's id; replies and controls from the same view carry it. */
  readonly hostId: number
  /** The view itself is gone (destroyed); a reload keeps it. */
  isGone(): boolean
  /** The view's main frame still hosts the document that asked (same frame host; a same-host
   *  replacement such as a `javascript:` URL or XSLT document is not detected). */
  isCurrent(): boolean
  /** Delivers only while `isCurrent()` holds; a replacement document receives nothing. */
  send(channel: string, payload: unknown): void
  /** Event-driven: aborts when the view is destroyed, crashes or navigates (did-navigate, unconditional),
   *  or when a later load event (did-fail-load, dom-ready) finds a document in a new frame host. */
  watchRetirement(): { signal: AbortSignal; dispose(): void }
}
