/**
 * Lets an open surface of the annotate mode (the notes list) take an Esc that arrives from the page, before the
 * picker treats it as "leave the mode". Keyed by page so another pane's list never swallows this page's Esc.
 */
const interceptors = new Map<string, () => boolean>()

export function registerAnnotateEscapeInterceptor(
  pageId: string,
  intercept: () => boolean
): () => void {
  interceptors.set(pageId, intercept)
  return () => {
    if (interceptors.get(pageId) === intercept) {
      interceptors.delete(pageId)
    }
  }
}

/** True when an open annotate surface handled the Esc, so the caller must not also exit. */
export function interceptAnnotateEscape(pageId: string): boolean {
  return interceptors.get(pageId)?.() ?? false
}
