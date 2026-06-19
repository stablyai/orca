import React, { useCallback, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { ExternalLink, Pencil, Unlink } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type LinkBubbleState = {
  href: string
  left: number
  top: number
}

export function getLinkBubblePosition(
  editor: Editor,
  rootEl: HTMLElement | null
): { left: number; top: number } | null {
  const { from } = editor.state.selection
  try {
    const coords = editor.view.coordsAtPos(from)
    const rootRect = rootEl?.getBoundingClientRect()
    if (!rootRect) {
      return null
    }
    return {
      left: coords.left - rootRect.left,
      top: coords.bottom - rootRect.top + 4
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
  linkBubble: LinkBubbleState
  isEditing: boolean
  onSave: (href: string) => void
  onRemove: () => void
  onEditStart: () => void
  onEditCancel: () => void
  onOpen: () => void
}

export function RichMarkdownLinkBubble({
  linkBubble,
  isEditing,
  onSave,
  onRemove,
  onEditStart,
  onEditCancel,
  onOpen
}: RichMarkdownLinkBubbleProps): React.JSX.Element {
  return (
    <div
      className="rich-markdown-link-bubble"
      style={{ left: linkBubble.left, top: linkBubble.top }}
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
}
