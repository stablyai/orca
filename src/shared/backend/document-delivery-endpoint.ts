/** One renderer document as application code sees it: identity, liveness and delivery, no native objects. */
export type DocumentDeliveryEndpoint = {
  /** The hosting view's id; replies and controls from the same view carry it. */
  readonly hostId: number
  /** The view itself is gone (destroyed); a reload keeps it. */
  isGone(): boolean
  /** The view still shows the document that asked, in its main frame. */
  isCurrent(): boolean
  send(channel: string, payload: unknown): void
  /** Aborts when the view is destroyed, crashes or commits a different document. */
  watchRetirement(): { signal: AbortSignal; dispose(): void }
}
