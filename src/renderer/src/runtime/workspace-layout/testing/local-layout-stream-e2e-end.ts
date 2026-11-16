// E2E builds only: its one call sits behind `import.meta.env.MODE === 'e2e'`, so other builds drop it.

/** Ends the window's current local layout stream from main's side, as a lost stream ends. */
export type LocalLayoutStreamE2EEnd = () => Promise<unknown>

/** Each snapshot names its stream; a reopened stream's snapshot replaces the one ended. */
export function exposeLocalLayoutStreamE2EEnd(rawFrame: unknown): void {
  if (typeof rawFrame !== 'object' || rawFrame === null || !('subscriptionId' in rawFrame)) {
    return
  }
  const subscriptionId = rawFrame.subscriptionId
  if (typeof subscriptionId === 'string') {
    window.__endLocalLayoutStreamE2E = () =>
      window.api.runtime.call({ method: 'layout.unsubscribe', params: { subscriptionId } })
  }
}
