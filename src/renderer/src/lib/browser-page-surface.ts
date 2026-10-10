// Marks web page content Orca draws itself (the remote screencast frame). `<webview>` guests and
// the annotation overlay drawn over a page count without it. Mouse Back/Forward there belong to
// the page, not worktree history.
export const BROWSER_PAGE_SURFACE_ATTRIBUTE = 'data-browser-page-surface'

const BROWSER_PAGE_SURFACE_SELECTOR = `webview, [${BROWSER_PAGE_SURFACE_ATTRIBUTE}], [data-orca-markup-overlay]`

export function isInsideBrowserPageSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(BROWSER_PAGE_SURFACE_SELECTOR) !== null
}
