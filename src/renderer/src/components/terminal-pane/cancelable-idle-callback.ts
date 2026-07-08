/** Schedule `callback` on an idle callback (setTimeout fallback), returning a
 *  canceler. */
export function scheduleCancelableIdleCallback(callback: () => void): () => void {
  // Why: requestIdleCallback is this-sensitive — an extracted unbound reference
  // throws "Illegal invocation" in Chromium, so always invoke as a method.
  const target = globalThis as {
    requestIdleCallback?: (cb: () => void) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (
    typeof target.requestIdleCallback === 'function' &&
    typeof target.cancelIdleCallback === 'function'
  ) {
    const id = target.requestIdleCallback(callback)
    return () => target.cancelIdleCallback?.(id)
  }
  const timer = setTimeout(callback, 0)
  return () => clearTimeout(timer)
}
