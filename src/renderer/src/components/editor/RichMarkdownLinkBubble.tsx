import { ImeInput } from '@/lib/ime-text-field'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { Copy, ExternalLink, Pencil, Unlink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { addViewportSizeChangeListener } from '@/hooks/viewport-size-change-listener'
import { isEditorAnchorVisible, observeAnchorAncestorVisibility } from './editor-anchor-visibility'

export type LinkBubbleState = {
  kind: 'markdown' | 'html-superscript'
  href: string
  left: number
  top: number
  openEnabled: boolean
  copyEnabled: boolean
  label?: string
}

const LINK_BUBBLE_VIEWPORT_MARGIN = 8
const LINK_BUBBLE_MAX_WIDTH = 344
const LINK_BUBBLE_HEIGHT = 40

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

function clampDocumentBubblePosition(linkBubble: LinkBubbleState): React.CSSProperties {
  // Body portals escape editor clipping; clamp viewport edges so all actions remain reachable.
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
    // Select the URL on entry to edit mode only; reselection on updates would interrupt typing.
    input.focus()
    input.select()
  }, [])

  return (
    <ImeInput
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
          // Editing Escape cancels the edit without reaching the container’s dismiss handler.
          e.stopPropagation()
          onCancel()
        }
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
  onCopy: () => void
  ownerId?: string
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
  onCopy,
  ownerId,
  portalToDocument = false
}: RichMarkdownLinkBubbleProps): React.JSX.Element {
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    if (!anchorElement || !isEditorAnchorVisible(anchorElement)) {
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
        !isEditorAnchorVisible(anchorElement) ||
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
      if (!entry?.isIntersecting || !isEditorAnchorVisible(anchorElement)) {
        dismiss()
      }
    })
    const mutationObserver = new MutationObserver(dismissIfLayoutInvalidated)
    const dismissOnScroll = (event: Event): void => {
      const target = event.target
      // Caret-driven input scrolling stays inside the bubble; only outside scroll invalidates document position.
      if (target instanceof Node && bubbleRef.current?.contains(target)) {
        return
      }
      dismiss()
    }

    resizeObserver.observe(anchorElement)
    intersectionObserver.observe(anchorElement)
    observeAnchorAncestorVisibility(mutationObserver, anchorElement)
    window.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('focusin', dismissOutside, true)
    window.addEventListener('scroll', dismissOnScroll, true)
    // Ignore resize events without dimension changes, such as main-window reveal reflow.
    const removeViewportListener = addViewportSizeChangeListener(dismiss)
    return () => {
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('focusin', dismissOutside, true)
      window.removeEventListener('scroll', dismissOnScroll, true)
      removeViewportListener()
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
      data-rich-markdown-link-bubble=""
      data-rich-markdown-link-bubble-owner={ownerId}
      style={positionStyle}
      onMouseDown={(e) => {
        // Keep button clicks from blurring the editor while allowing inputs to receive focus.
        if (!(e.target instanceof HTMLInputElement)) {
          e.preventDefault()
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onDismiss()
          anchorElement?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
          return
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
          return
        }
        const buttons = Array.from(
          bubbleRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []
        )
        const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (currentIndex === -1 || buttons.length === 0) {
          return
        }
        event.preventDefault()
        const direction = event.key === 'ArrowRight' ? 1 : -1
        buttons[(currentIndex + direction + buttons.length) % buttons.length]?.focus()
      }}
    >
      {isEditing ? (
        <LinkEditInput initialHref={linkBubble.href} onSave={onSave} onCancel={onEditCancel} />
      ) : (
        <>
          <span className="rich-markdown-link-url" title={linkBubble.href}>
            {linkBubble.href.length > 40 ? `${linkBubble.href.slice(0, 40)}…` : linkBubble.href}
          </span>
          <LinkBubbleAction
            label={translate(
              'auto.components.editor.RichMarkdownLinkBubble.bfc813e909',
              'Open link'
            )}
            disabled={!linkBubble.openEnabled}
            onClick={onOpen}
          >
            <ExternalLink size={14} />
          </LinkBubbleAction>
          <LinkBubbleAction
            label={translate('auto.components.editor.RichMarkdownLinkBubble.copyLink', 'Copy link')}
            disabled={!linkBubble.copyEnabled}
            onClick={onCopy}
          >
            <Copy size={14} />
          </LinkBubbleAction>
          {linkBubble.kind === 'markdown' ? (
            <>
              <LinkBubbleAction
                label={translate(
                  'auto.components.editor.RichMarkdownLinkBubble.cdfe166f6f',
                  'Edit link'
                )}
                onClick={onEditStart}
              >
                <Pencil size={14} />
              </LinkBubbleAction>
              <LinkBubbleAction
                label={translate(
                  'auto.components.editor.RichMarkdownLinkBubble.1c99b726e0',
                  'Remove link'
                )}
                onClick={onRemove}
              >
                <Unlink size={14} />
              </LinkBubbleAction>
            </>
          ) : null}
        </>
      )}
    </div>
  )

  // Portal URL actions above the sidebar because editor panes clip at the workbench boundary.
  return portalToDocument ? createPortal(bubble, document.body) : bubble
}

function LinkBubbleAction({
  children,
  disabled = false,
  label,
  onClick
}: {
  children: React.ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="rich-markdown-link-button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
