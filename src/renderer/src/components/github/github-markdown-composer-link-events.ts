import type { EditorView } from '@tiptap/pm/view'
import type { MutableRefObject } from 'react'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

function getComposerClickedHttpHref(view: EditorView, event: MouseEvent): string {
  const target =
    event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null
  const link = target?.closest('a')
  if (!link || !view.dom.contains(link)) {
    return ''
  }
  let pos: number
  try {
    pos = view.posAtDOM(link, 0)
  } catch {
    return ''
  }
  const mark = view.state.doc.nodeAt(pos)?.marks.find((candidate) => candidate.type.name === 'link')
  const href = mark ? String(mark.attrs.href ?? '') : ''
  return /^https?:\/\//i.test(href) ? href : ''
}

export function handleGitHubComposerLinkMouseDown(
  view: EditorView,
  event: MouseEvent,
  handledPointerUpLinkClickRef: MutableRefObject<boolean>
): boolean {
  handledPointerUpLinkClickRef.current = false
  if (event.button === 1 && getComposerClickedHttpHref(view, event)) {
    event.preventDefault()
    return true
  }
  return false
}

export function handleGitHubComposerLinkMouseUp(view: EditorView, event: MouseEvent): boolean {
  if (event.button === 1 && getComposerClickedHttpHref(view, event)) {
    event.preventDefault()
    return true
  }
  return false
}

export function handleGitHubComposerLinkAuxClick(
  view: EditorView,
  event: MouseEvent,
  onCloseLinkBubble: () => void
): boolean {
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

export function handleGitHubComposerLinkDomClick(
  view: EditorView,
  event: MouseEvent,
  handledPointerUpLinkClickRef: MutableRefObject<boolean>,
  onCloseLinkBubble: () => void
): boolean {
  if (handledPointerUpLinkClickRef.current) {
    handledPointerUpLinkClickRef.current = false
    event.preventDefault()
    return true
  }
  if (event.defaultPrevented || event.button !== 0) {
    return false
  }
  const isMac = navigator.userAgent.includes('Mac')
  const modKey = isMac ? event.metaKey : event.ctrlKey
  if (event.shiftKey && !modKey) {
    return false
  }
  if (!modKey && !view.state.selection.empty) {
    return false
  }
  const href = getComposerClickedHttpHref(view, event)
  if (!href) {
    return false
  }
  event.preventDefault()
  onCloseLinkBubble()
  openAppHttpLink(href, { destination: event.shiftKey && modKey ? 'system' : 'orca' })
  return true
}

export function handleGitHubComposerProseMirrorClick(
  view: EditorView,
  event: MouseEvent,
  handledPointerUpLinkClickRef: MutableRefObject<boolean>,
  onCloseLinkBubble: () => void
): boolean {
  if (event.shiftKey) {
    return false
  }
  const href = getComposerClickedHttpHref(view, event)
  if (!href) {
    return false
  }
  onCloseLinkBubble()
  openAppHttpLink(href, { destination: 'orca' })
  handledPointerUpLinkClickRef.current = true
  return true
}
