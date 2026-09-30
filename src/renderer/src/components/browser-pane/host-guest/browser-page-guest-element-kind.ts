import { OFFSCREEN_PAGE_TAG } from '../../../../../shared/offscreen-page-protocol'

export { OFFSCREEN_PAGE_TAG }

/** True for either browser page surface: a real <webview> or its offscreen stand-in. */
export function isBrowserPageGuestElement(
  element: { tagName?: string } | null | undefined
): boolean {
  const tagName = element?.tagName
  return tagName === 'WEBVIEW' || tagName === OFFSCREEN_PAGE_TAG.toUpperCase()
}
