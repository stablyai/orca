import type { EditorView } from '@tiptap/pm/view'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import {
  createMarkdownLinkDomEventHandlers,
  getClickedLinkHref
} from '@/components/editor/rich-markdown/links/rich-markdown-link-dom-events'

function getComposerClickedHttpHref(view: EditorView, event: MouseEvent): string {
  const href = getClickedLinkHref(view, event)
  return /^https?:\/\//i.test(href) ? href : ''
}

export function createGitHubComposerLinkEventHandlers(onCloseLinkBubble: () => void) {
  const isMac = navigator.userAgent.includes('Mac')
  return createMarkdownLinkDomEventHandlers({
    isMac,
    isMiddleClickable: (view, event) => Boolean(getComposerClickedHttpHref(view, event)),
    handleClick: (view, _pos, event) => {
      const href = getComposerClickedHttpHref(view, event)
      if (!href) {
        return false
      }
      onCloseLinkBubble()
      // No destination override: openAppHttpLink routes by the Link setting and the Shift
      // escape modifier, so a disabled routing setting reaches the system browser here too (#44311).
      openAppHttpLink(href, { event })
      return true
    },
    handleAuxClick: (view, event) => {
      if (event.defaultPrevented || event.button !== 1) {
        return false
      }
      const href = getComposerClickedHttpHref(view, event)
      if (!href) {
        return false
      }
      event.preventDefault()
      onCloseLinkBubble()
      openAppHttpLink(href, { destination: 'system' })
      return true
    }
  })
}
