import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from './browser-annotation-viewport-bridge'

/**
 * What annotate needs to hear from the page's document, wherever the page renders: a local
 * webview's DOM events or the host's guest events relayed over `browser.grab.watch`.
 */
export type BrowserGuestDocumentEvent =
  /** A viewport bridge report, still carrying its token for the viewer to check. */
  | { type: 'viewport'; message: string }
  /** The guest began replacing its main document, a same-URL reload included. */
  | { type: 'documentStart' }
  /** The main frame committed a URL, by navigation or in place. */
  | { type: 'navigated'; url: string }
  /** A new document can run scripts again; its in-page badges must be redrawn. */
  | { type: 'domReady' }

// A report is a few small numbers; anything longer did not come from the bridge.
export const BROWSER_GUEST_VIEWPORT_MESSAGE_MAX_LENGTH = 2_000

export function isBrowserGuestViewportMessage(message: unknown): message is string {
  return (
    typeof message === 'string' &&
    message.length <= BROWSER_GUEST_VIEWPORT_MESSAGE_MAX_LENGTH &&
    message.startsWith(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX)
  )
}

export function parseBrowserGuestDocumentEvent(value: unknown): BrowserGuestDocumentEvent | null {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return null
  }
  switch (value.type) {
    case 'viewport': {
      const message = 'message' in value ? value.message : undefined
      return isBrowserGuestViewportMessage(message) ? { type: 'viewport', message } : null
    }
    case 'documentStart':
      return { type: 'documentStart' }
    case 'navigated': {
      const url = 'url' in value ? value.url : undefined
      return typeof url === 'string' ? { type: 'navigated', url } : null
    }
    case 'domReady':
      return { type: 'domReady' }
    default:
      return null
  }
}
