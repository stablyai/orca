import { OFFSCREEN_PAGE_TAG } from './browser-page-guest-element-kind'
import { defineOffscreenPageElement, OrcaOffscreenPageElement } from './offscreen-page-element'

/** Creates the offscreen stand-in for a page's <webview>; the pane drives it through the same calls. */
export function createOffscreenPageGuestElement(browserPageId: string): Electron.WebviewTag {
  defineOffscreenPageElement()
  const element = document.createElement(OFFSCREEN_PAGE_TAG)
  if (!(element instanceof OrcaOffscreenPageElement)) {
    throw new Error('Offscreen page element failed to register')
  }
  element.dataset.browserPageId = browserPageId
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the element implements every WebviewTag member the browser pane calls (host-guest, assemble-chrome, navigate, annotate); the rest are never reached for local pages.
  return element as unknown as Electron.WebviewTag
}
