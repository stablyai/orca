/**
 * What the annotate tools treat as "the page's document" in a browser pane.
 * Why not the URL: pushState, replaceState and hash changes rewrite it without a new document, and must not withdraw
 * a held pick or the Undo offer. Every new document (navigation, reload) goes through a load, and each load start is
 * a new generation for the tools (see useBrowserAnnotateToolSwitch's documentReady).
 */
export function browserPageDocumentIdentity(
  tab: { id: string; loading: boolean },
  generation: number
): {
  documentKey: string
  documentReady: boolean
} {
  return { documentKey: `${tab.id}\n${generation}`, documentReady: !tab.loading }
}
