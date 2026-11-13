import { getMarkRange } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'

const LINK_HOVER_OPEN_DELAY_MS = 150
const LINK_HOVER_CLOSE_DELAY_MS = 150

function hasSelectionInsideLinkBubble(ownerDocument: Document): boolean {
  const selection = ownerDocument.getSelection()
  if (!selection || selection.isCollapsed) {
    return false
  }
  const anchorElement =
    selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode?.parentElement
  return Boolean(anchorElement?.closest('[data-rich-markdown-link-bubble]'))
}

export function measureHoveredLinkBubblePosition(
  element: HTMLElement,
  point: { x: number; y: number }
): { left: number; top: number } {
  const clientRects = Array.from(element.getClientRects())
  const matchedRect = clientRects.find(
    (rect) =>
      point.x >= rect.left - 2 &&
      point.x <= rect.right + 2 &&
      point.y >= rect.top - 2 &&
      point.y <= rect.bottom + 2
  )
  const rect = matchedRect ?? element.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.bottom + 4
  }
}

export function findRichMarkdownHoveredLinkElement(
  editor: Editor | null,
  target: EventTarget | null
): HTMLElement | null {
  if (!editor || editor.isDestroyed) {
    return null
  }
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (!element) {
    return null
  }
  const citation = element.closest<HTMLElement>('sup[data-rich-markdown-html-superscript-link]')
  if (citation && editor.view.dom.contains(citation)) {
    return citation
  }
  const anchor = element.closest<HTMLAnchorElement>('a')
  if (anchor && editor.view.dom.contains(anchor)) {
    return anchor
  }
  return null
}

export function resolveRichMarkdownHoveredLinkBubble(
  editor: Editor | null,
  linkElement: HTMLElement,
  point: { x: number; y: number }
): LinkBubbleState | null {
  if (!editor || editor.isDestroyed || !editor.view.dom.contains(linkElement)) {
    return null
  }
  const { view } = editor
  const position = measureHoveredLinkBubblePosition(linkElement, point)

  if (linkElement.hasAttribute('data-rich-markdown-html-superscript-link')) {
    let pos: number
    try {
      pos = view.posAtDOM(linkElement, 0)
    } catch {
      return null
    }
    const directNode = view.state.doc.nodeAt(pos)
    const beforeNode = view.state.doc.resolve(pos).nodeBefore
    const citationNode =
      directNode?.type.name === 'richMarkdownHtmlSuperscriptLink'
        ? directNode
        : beforeNode?.type.name === 'richMarkdownHtmlSuperscriptLink'
          ? beforeNode
          : null
    if (!citationNode) {
      return null
    }
    const href = String(citationNode.attrs.href ?? '')
    return {
      kind: 'html-superscript',
      href,
      label: String(citationNode.attrs.label ?? ''),
      copyEnabled: Boolean(href),
      ...position
    }
  }

  let linkPos: number
  try {
    linkPos = view.posAtDOM(linkElement, 0)
  } catch {
    return null
  }
  const linkMarkType = view.state.schema.marks.link
  if (!linkMarkType) {
    return null
  }
  const $pos = view.state.doc.resolve(linkPos)
  const linkMark =
    view.state.doc.nodeAt(linkPos)?.marks.find((mark) => mark.type === linkMarkType) ??
    $pos.marks().find((mark) => mark.type === linkMarkType)
  if (!linkMark) {
    return null
  }
  const href = String(linkMark.attrs.href ?? '')
  const targetRange = getMarkRange($pos, linkMarkType, linkMark.attrs) || undefined
  return {
    kind: 'markdown',
    href,
    copyEnabled: Boolean(href),
    targetRange,
    ...position
  }
}

export function useMarkdownLinkHoverBubble({
  containerElement,
  isOpen,
  isEditing = false,
  findLinkElement,
  resolveLinkBubble,
  setLinkBubble
}: {
  containerElement: HTMLElement | null
  isOpen: boolean
  isEditing?: boolean
  findLinkElement: (target: EventTarget | null) => HTMLElement | null
  resolveLinkBubble: (
    linkElement: HTMLElement,
    point: { x: number; y: number }
  ) => LinkBubbleState | null
  setLinkBubble: (bubble: LinkBubbleState | null) => void
}): {
  cancelHoverBubble: () => void
  onBubblePointerEnter: React.PointerEventHandler<HTMLDivElement>
  onBubblePointerLeave: React.PointerEventHandler<HTMLDivElement>
} {
  const isEditingRef = useRef(isEditing)
  const findLinkElementRef = useRef(findLinkElement)
  const resolveLinkBubbleRef = useRef(resolveLinkBubble)
  const setLinkBubbleRef = useRef(setLinkBubble)

  useEffect(() => {
    isEditingRef.current = isEditing
    findLinkElementRef.current = findLinkElement
    resolveLinkBubbleRef.current = resolveLinkBubble
    setLinkBubbleRef.current = setLinkBubble
  }, [findLinkElement, isEditing, resolveLinkBubble, setLinkBubble])

  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const pendingElementRef = useRef<HTMLElement | null>(null)
  const activeElementRef = useRef<HTMLElement | null>(null)
  const pointerPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    pendingElementRef.current = null
  }, [])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      const ownerDoc = activeElementRef.current?.ownerDocument ?? document
      if (isEditingRef.current || hasSelectionInsideLinkBubble(ownerDoc)) {
        return
      }
      activeElementRef.current = null
      setLinkBubbleRef.current(null)
    }, LINK_HOVER_CLOSE_DELAY_MS)
  }, [clearCloseTimer])

  const cancelHoverBubble = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    activeElementRef.current = null
  }, [clearCloseTimer, clearOpenTimer])

  useEffect(() => {
    if (!isOpen) {
      activeElementRef.current = null
    }
  }, [isOpen])

  useEffect(() => {
    if (isEditing) {
      clearOpenTimer()
      clearCloseTimer()
    }
  }, [clearCloseTimer, clearOpenTimer, isEditing])

  useEffect(() => {
    if (!containerElement) {
      return
    }

    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || event.buttons !== 0 || isEditingRef.current) {
        return
      }
      const linkElement = findLinkElementRef.current(event.target)
      if (!linkElement) {
        return
      }
      pointerPointRef.current = { x: event.clientX, y: event.clientY }
      clearCloseTimer()
      if (activeElementRef.current === linkElement || pendingElementRef.current === linkElement) {
        return
      }
      clearOpenTimer()
      pendingElementRef.current = linkElement
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null
        pendingElementRef.current = null
        if (isEditingRef.current || !linkElement.isConnected) {
          return
        }
        const bubble = resolveLinkBubbleRef.current(linkElement, pointerPointRef.current)
        if (!bubble) {
          return
        }
        activeElementRef.current = linkElement
        setLinkBubbleRef.current(bubble)
      }, LINK_HOVER_OPEN_DELAY_MS)
    }

    const onPointerOut = (event: PointerEvent): void => {
      const leavingElement = findLinkElementRef.current(event.target)
      if (!leavingElement) {
        return
      }
      const related = event.relatedTarget
      if (related instanceof Node && leavingElement.contains(related)) {
        return
      }
      if (pendingElementRef.current === leavingElement) {
        clearOpenTimer()
      }
      if (activeElementRef.current === leavingElement && !isEditingRef.current) {
        scheduleClose()
      }
    }

    const onPointerDown = (event: PointerEvent): void => {
      const targetElement =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null
      if (targetElement?.closest('[data-rich-markdown-link-bubble]')) {
        return
      }
      clearOpenTimer()
      clearCloseTimer()
      if (!isEditingRef.current && activeElementRef.current) {
        activeElementRef.current = null
        setLinkBubbleRef.current(null)
      }
    }

    containerElement.addEventListener('pointerover', onPointerOver)
    containerElement.addEventListener('pointerout', onPointerOut)
    containerElement.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      clearOpenTimer()
      clearCloseTimer()
      containerElement.removeEventListener('pointerover', onPointerOver)
      containerElement.removeEventListener('pointerout', onPointerOut)
      containerElement.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [clearCloseTimer, clearOpenTimer, containerElement, scheduleClose])

  const onBubblePointerEnter = useCallback<React.PointerEventHandler<HTMLDivElement>>(() => {
    clearCloseTimer()
  }, [clearCloseTimer])

  const onBubblePointerLeave = useCallback<React.PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (
        event.relatedTarget instanceof Element &&
        event.relatedTarget.closest('[data-slot="tooltip-content"]')
      ) {
        return
      }
      if (!isEditingRef.current) {
        scheduleClose()
      }
    },
    [scheduleClose]
  )

  return {
    cancelHoverBubble,
    onBubblePointerEnter,
    onBubblePointerLeave
  }
}
