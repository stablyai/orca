import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { ExternalLink, Pencil, Unlink } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type LinkBubbleState = {
  href: string
  left: number
  top: number
}

const LINK_BUBBLE_VIEWPORT_MARGIN = 8
const LINK_BUBBLE_MAX_WIDTH = 344
const LINK_BUBBLE_HEIGHT = 40
const LINK_BUBBLE_LAYOUT_ATTRIBUTES = ['aria-hidden', 'class', 'hidden', 'inert', 'style']

function hasRectChanged(initialRect: DOMRect, nextRect: DOMRect): boolean {
  return (
    Math.abs(nextRect.left - initialRect.left) > 0.5 ||
    Math.abs(nextRect.top - initialRect.top) > 0.5 ||
    Math.abs(nextRect.width - initialRect.width) > 0.5 ||
    Math.abs(nextRect.height - initialRect.height) > 0.5
  )
}

function getStableAnchorClassName(anchorElement: HTMLElement): string {
  return [...anchorElement.classList]
    .filter((className) => className !== 'rich-markdown-mod-held')
    .sort()
    .join(' ')
}

function isAnchorVisible(anchorElement: HTMLElement): boolean {
  if (!anchorElement.isConnected || anchorElement.getClientRects().length === 0) {
    return false
  }
  for (let element: HTMLElement | null = anchorElement; element; element = element.parentElement) {
    const style = window.getComputedStyle(element)
    if (
      element.hidden ||
      element.inert ||
      element.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number.parseFloat(style.opacity) === 0
    ) {
      return false
    }
  }
  return true
}

function clampDocumentBubblePosition(linkBubble: LinkBubbleState): React.CSSProperties {
  // Why: the body portal no longer inherits editor clipping, so keep every
  // action reachable when the selected link sits at a window edge.
  const maxLeft = Math.max(
    LINK_BUBBLE_VIEWPORT_MARGIN,
    window.innerWidth - LINK_BUBBLE_MAX_WIDTH - LINK_BUBBLE_VIEWPORT_MARGIN
  )
  const maxTop = Math.max(
    LINK_BUBBLE_VIEWPORT_MARGIN,
    window.innerHeight - LINK_BUBBLE_HEIGHT - LINK_BUBBLE_VIEWPORT_MARGIN
  )
  return {
    position: 'fixed',
    left: Math.min(Math.max(linkBubble.left, LINK_BUBBLE_VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(linkBubble.top, LINK_BUBBLE_VIEWPORT_MARGIN), maxTop)
  }
}

export function getLinkBubblePosition(
  editor: Editor,
  rootEl: HTMLElement | null
): { left: number; top: number } | null {
  const { from } = editor.state.selection
  try {
    const coords = editor.view.coordsAtPos(from)
    if (!rootEl) {
      return null
    }
    return {
      left: coords.left,
      top: coords.bottom + 4
    }
  } catch {
    return null
  }
}

export function isLinkEditCancelShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
  isMac: boolean
): boolean {
  if (event.key.toLowerCase() !== 'k') {
    return false
  }
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

function LinkEditInput({
  initialHref,
  onSave,
  onCancel
}: {
  initialHref: string
  onSave: (href: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initialHref)
  const isMac = navigator.userAgent.includes('Mac')

  const setInputElement = useCallback((input: HTMLInputElement | null) => {
    if (!input) {
      return
    }
    // Why: edit mode should start with the current URL selected, but typing
    // changes must not re-select the field on every value update.
    input.focus()
    input.select()
  }, [])

  return (
    <input
      ref={setInputElement}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onSave(value.trim())
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
        // Cmd/Ctrl+K while editing cancels the edit.
        if (isLinkEditCancelShortcut(e, isMac)) {
          e.preventDefault()
          onCancel()
        }
      }}
      placeholder={translate(
        'auto.components.editor.RichMarkdownLinkBubble.7b0b945fdc',
        'Paste or type a link…'
      )}
      className="rich-markdown-link-input"
    />
  )
}

type RichMarkdownLinkBubbleProps = {
  anchorElement: HTMLElement | null
  linkBubble: LinkBubbleState
  isEditing: boolean
  onDismiss: () => void
  onSave: (href: string) => void
  onRemove: () => void
  onEditStart: () => void
  onEditCancel: () => void
  onOpen: () => void
  portalToDocument?: boolean
}

export function RichMarkdownLinkBubble({
  anchorElement,
  linkBubble,
  isEditing,
  onDismiss,
  onSave,
  onRemove,
  onEditStart,
  onEditCancel,
  onOpen,
  portalToDocument = false
}: RichMarkdownLinkBubbleProps): React.JSX.Element {
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    if (!anchorElement || !isAnchorVisible(anchorElement)) {
      onDismissRef.current()
      return
    }

    const dismiss = (): void => onDismissRef.current()
    const dismissOutside = (event: Event): void => {
      const target = event.target
      if (
        target instanceof Node &&
        !anchorElement.contains(target) &&
        !bubbleRef.current?.contains(target)
      ) {
        dismiss()
      }
    }
    const initialRect = anchorElement.getBoundingClientRect()
    const initialAnchorClassName = getStableAnchorClassName(anchorElement)
    const dismissIfLayoutInvalidated = (mutations: MutationRecord[] = []): void => {
      const anchorStyleChanged = mutations.some(
        (mutation) => mutation.target === anchorElement && mutation.attributeName === 'style'
      )
      if (
        !isAnchorVisible(anchorElement) ||
        hasRectChanged(initialRect, anchorElement.getBoundingClientRect()) ||
        getStableAnchorClassName(anchorElement) !== initialAnchorClassName ||
        anchorStyleChanged
      ) {
        dismiss()
      }
    }
    const resizeObserver = new ResizeObserver(() => {
      dismissIfLayoutInvalidated()
    })
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || !isAnchorVisible(anchorElement)) {
        dismiss()
      }
    })
    const mutationObserver = new MutationObserver(dismissIfLayoutInvalidated)
    const dismissOnScroll = (event: Event): void => {
      const target = event.target
      // Why: long URL inputs scroll horizontally to keep the caret visible;
      // only scrolling outside the bubble invalidates its document position.
      if (target instanceof Node && bubbleRef.current?.contains(target)) {
        return
      }
      dismiss()
    }

    resizeObserver.observe(anchorElement)
    intersectionObserver.observe(anchorElement)
    for (
      let element: HTMLElement | null = anchorElement;
      element;
      element = element.parentElement
    ) {
      mutationObserver.observe(element, {
        attributes: true,
        attributeFilter: LINK_BUBBLE_LAYOUT_ATTRIBUTES
      })
    }
    window.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('focusin', dismissOutside, true)
    window.addEventListener('scroll', dismissOnScroll, true)
    window.addEventListener('resize', dismiss)
    return () => {
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('focusin', dismissOutside, true)
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [anchorElement])

  const anchorRect = anchorElement?.getBoundingClientRect()
  const positionStyle: React.CSSProperties = portalToDocument
    ? clampDocumentBubblePosition(linkBubble)
    : {
        position: 'absolute',
        left: linkBubble.left - (anchorRect?.left ?? 0),
        top: linkBubble.top - (anchorRect?.top ?? 0)
      }

  const bubble = (
    <div
      ref={bubbleRef}
      className="rich-markdown-link-bubble"
      style={positionStyle}
      onMouseDown={(e) => {
        // Prevent editor blur when clicking bubble buttons, but let inputs
        // receive focus normally.
        if (!(e.target instanceof HTMLInputElement)) {
          e.preventDefault()
        }
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {isEditing ? (
        <LinkEditInput initialHref={linkBubble.href} onSave={onSave} onCancel={onEditCancel} />
      ) : (
        <>
          <span className="rich-markdown-link-url" title={linkBubble.href}>
            {linkBubble.href.length > 40 ? `${linkBubble.href.slice(0, 40)}…` : linkBubble.href}
          </span>
          <button
            type="button"
            className="rich-markdown-link-button"
            onClick={onOpen}
            title={translate(
              'auto.components.editor.RichMarkdownLinkBubble.bfc813e909',
              'Open link'
            )}
          >
            <ExternalLink size={14} />
          </button>
          <button
            type="button"
            className="rich-markdown-link-button"
            onClick={onEditStart}
            title={translate(
              'auto.components.editor.RichMarkdownLinkBubble.cdfe166f6f',
              'Edit link'
            )}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="rich-markdown-link-button"
            onClick={onRemove}
            title={translate(
              'auto.components.editor.RichMarkdownLinkBubble.1c99b726e0',
              'Remove link'
            )}
          >
            <Unlink size={14} />
          </button>
        </>
      )}
    </div>
  )

  // Why: editor panes clip overflow at the workbench boundary, so the URL
  // actions must portal to the app layer to remain above the right sidebar.
  return portalToDocument ? createPortal(bubble, document.body) : bubble
}
