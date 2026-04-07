import React, { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { ExternalLink, Pencil, Unlink } from 'lucide-react'

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
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
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
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault()
          onCancel()
        }
      }}
      placeholder="Paste or type a link…"
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
            title="Open link"
          >
            <ExternalLink size={14} />
          </button>
          <button
            type="button"
            className="rich-markdown-link-button"
            onClick={onEditStart}
            title="Edit link"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="rich-markdown-link-button"
            onClick={onRemove}
            title="Remove link"
          >
            <Unlink size={14} />
          </button>
        </>
      )}
    </div>
  )
}
