import type { EditorView } from '@tiptap/pm/view'
import { useAppStore } from '@/store/index'
import { openMarkdownExternalUrl } from '../../markdown/link-routing/markdown-external-url-open'
import { resolveMarkdownLinkTarget } from '../../markdown/link-routing/markdown-internal-links'
import {
  classifyHtmlSuperscriptLinkAction,
  type RichMarkdownHtmlSuperscriptLinkContext
} from '../citations/rich-markdown-html-superscript-link-context'

export function getClickedLinkHref(view: EditorView, event: MouseEvent): string {
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
  // The rendered href is blanked for file:, drive-path and custom schemes, so read the mark instead.
  let linkPos: number
  try {
    linkPos = view.posAtDOM(link, 0)
  } catch {
    return ''
  }
  const linkMark = view.state.doc.nodeAt(linkPos)?.marks.find((mark) => mark.type.name === 'link')
  return linkMark ? String(linkMark.attrs.href ?? '') : ''
}

export function getClickedAnyLinkHref(
  view: EditorView,
  event: MouseEvent,
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
): string {
  const target =
    event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null
  const citation = target?.closest('sup[data-rich-markdown-html-superscript-link]')
  if (citation && view.dom.contains(citation)) {
    let citationPos: number
    try {
      citationPos = view.posAtDOM(citation, 0)
    } catch {
      return ''
    }
    const directNode = view.state.doc.nodeAt(citationPos)
    const beforeNode = view.state.doc.resolve(citationPos).nodeBefore
    const citationNode =
      directNode?.type.name === 'richMarkdownHtmlSuperscriptLink'
        ? directNode
        : beforeNode?.type.name === 'richMarkdownHtmlSuperscriptLink'
          ? beforeNode
          : null
    const href = citationNode ? String(citationNode.attrs.href ?? '') : ''
    return classifyHtmlSuperscriptLinkAction(href, htmlSuperscriptLinkContext.getSnapshot())
      ? href
      : ''
  }
  return getClickedLinkHref(view, event)
}

export function resolveRichMarkdownDomEventPos(view: EditorView, event: MouseEvent): number | null {
  const fromCoords = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (fromCoords) {
    return fromCoords.pos
  }
  const targetElement =
    event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null
  const linkLike = targetElement?.closest(
    'a, sup[data-rich-markdown-html-superscript-link], [data-doc-link-target]'
  )
  if (!linkLike || !view.dom.contains(linkLike)) {
    return null
  }
  try {
    return view.posAtDOM(linkLike, 0)
  } catch {
    return null
  }
}

export function isRichMarkdownActionableLinkTarget(
  view: EditorView,
  event: MouseEvent,
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
): boolean {
  return Boolean(getClickedAnyLinkHref(view, event, htmlSuperscriptLinkContext))
}

export function handleRichMarkdownEditorAuxClick({
  event,
  filePath,
  htmlSuperscriptLinkContext,
  view,
  worktreeId,
  worktreeRoot
}: {
  event: MouseEvent
  filePath: string
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
  view: EditorView
  worktreeId: string
  worktreeRoot: string | null
}): boolean {
  if (event.defaultPrevented || event.button !== 1) {
    return false
  }
  const href = getClickedAnyLinkHref(view, event, htmlSuperscriptLinkContext)
  if (!href) {
    return false
  }
  const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
  if (classified?.kind !== 'external') {
    return false
  }
  event.preventDefault()
  openMarkdownExternalUrl(classified.url, {
    state: useAppStore.getState(),
    worktreeId,
    sourceOwner: htmlSuperscriptLinkContext.getSnapshot().sourceOwner,
    destination: 'system'
  })
  return true
}

export function createRichMarkdownLinkDomEventHandlers({
  filePath,
  handleClick,
  htmlSuperscriptLinkContext,
  isMac,
  onDismissLinkBubble,
  worktreeId,
  worktreeRoot
}: {
  filePath: string
  handleClick: (view: EditorView, pos: number, event: MouseEvent) => boolean
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
  isMac: boolean
  onDismissLinkBubble: () => void
  worktreeId: string
  worktreeRoot: string | null
}): {
  domEvents: {
    mousedown: (view: EditorView, event: MouseEvent) => boolean
    mouseup: (view: EditorView, event: MouseEvent) => boolean
    auxclick: (view: EditorView, event: MouseEvent) => boolean
    click: (view: EditorView, event: MouseEvent) => boolean
  }
  handleProseMirrorClick: (view: EditorView, pos: number, event: MouseEvent) => boolean
} {
  return createMarkdownLinkDomEventHandlers({
    isMac,
    isMiddleClickable: (view, event) =>
      isRichMarkdownActionableLinkTarget(view, event, htmlSuperscriptLinkContext),
    handleClick,
    handleAuxClick: (view, event) => {
      const handled = handleRichMarkdownEditorAuxClick({
        event,
        filePath,
        htmlSuperscriptLinkContext,
        view,
        worktreeId,
        worktreeRoot
      })
      if (handled) {
        onDismissLinkBubble()
      }
      return handled
    }
  })
}

export function createMarkdownLinkDomEventHandlers({
  isMac,
  isMiddleClickable,
  handleClick,
  handleAuxClick
}: {
  isMac: boolean
  isMiddleClickable: (view: EditorView, event: MouseEvent) => boolean
  handleClick: (view: EditorView, pos: number, event: MouseEvent) => boolean
  handleAuxClick: (view: EditorView, event: MouseEvent) => boolean
}) {
  let pointerUpClickResult: boolean | null = null
  const preventMiddleClickDefault = (view: EditorView, event: MouseEvent): boolean => {
    if (event.button !== 1 || !isMiddleClickable(view, event)) {
      return false
    }
    event.preventDefault()
    return true
  }

  return {
    domEvents: {
      mousedown: (view: EditorView, event: MouseEvent) => {
        pointerUpClickResult = null
        return preventMiddleClickDefault(view, event)
      },
      mouseup: preventMiddleClickDefault,
      auxclick: handleAuxClick,
      // ProseMirror skips handleClick for Shift gestures and synthetic/keyboard clicks without mousedown.
      click: (view: EditorView, event: MouseEvent) => {
        if (pointerUpClickResult !== null) {
          const handled = pointerUpClickResult
          pointerUpClickResult = null
          if (handled) {
            event.preventDefault()
          }
          return handled
        }
        if (event.defaultPrevented || event.button !== 0) {
          return false
        }
        const modKey = isMac ? event.metaKey : event.ctrlKey
        if (event.shiftKey && !modKey) {
          return false
        }
        if (!modKey && !view.state.selection.empty) {
          return false
        }
        const pos = resolveRichMarkdownDomEventPos(view, event)
        if (pos === null || !handleClick(view, pos, event)) {
          return false
        }
        event.preventDefault()
        return true
      }
    },
    handleProseMirrorClick: (view: EditorView, pos: number, event: MouseEvent) => {
      if (event.shiftKey) {
        return false
      }
      pointerUpClickResult = handleClick(view, pos, event)
      return pointerUpClickResult
    }
  }
}
