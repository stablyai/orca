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
      const modKey = isMac ? event.metaKey : event.ctrlKey
      openAppHttpLink(href, { destination: event.shiftKey && modKey ? 'system' : 'orca' })
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
