import type React from 'react'
import { useCallback, useEffect } from 'react'
import type { Editor } from '@tiptap/react'
import type { EditorEvents } from '@tiptap/core'
import { getLinkBubblePosition, type LinkBubbleState } from './RichMarkdownLinkBubble'
import { copyRichMarkdownLink } from './rich-markdown-link-clipboard'
import {
  createEditableMarkdownLinkBubble,
  getRichMarkdownSelectionLinkBubble
} from './rich-markdown-selected-link-actions'
import {
  findRichMarkdownHoveredLinkElement,
  resolveRichMarkdownHoveredLinkBubble,
  useMarkdownLinkHoverBubble
} from './use-markdown-link-hover-bubble'

function isValidTargetRange(
  editor: Editor,
  targetRange: { from: number; to: number } | undefined
): targetRange is { from: number; to: number } {
  return (
    targetRange !== undefined &&
    targetRange.from >= 0 &&
    targetRange.to <= editor.state.doc.content.size &&
    targetRange.from <= targetRange.to
  )
}

export function applyRichMarkdownLinkSave(
  editor: Editor,
  href: string,
  targetRange?: { from: number; to: number }
): void {
  if (isValidTargetRange(editor, targetRange)) {
    if (href) {
      editor.chain().focus().setTextSelection(targetRange).setLink({ href }).run()
    } else {
      editor.chain().focus().setTextSelection(targetRange).unsetLink().run()
    }
    return
  }
  if (href) {
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
      return
    }
    const { from, to } = editor.state.selection
    if (from === to) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: href,
          marks: [{ type: 'link', attrs: { href } }]
        })
        .run()
      return
    }
    editor.chain().focus().setLink({ href }).run()
    return
  }
  if (editor.isActive('link')) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  editor.commands.focus()
}

export function applyRichMarkdownLinkRemove(
  editor: Editor,
  targetRange?: { from: number; to: number }
): void {
  if (isValidTargetRange(editor, targetRange)) {
    editor.chain().focus().setTextSelection(targetRange).unsetLink().run()
    return
  }
  editor.chain().focus().extendMarkRange('link').unsetLink().run()
}

// Keep state in the parent so callbacks created during editor initialization can access its setters.
export function useLinkBubble(
  editor: Editor | null,
  rootRef: React.RefObject<HTMLElement | null>,
  linkBubble: LinkBubbleState | null,
  isEditingLink: boolean,
  setLinkBubble: (v: LinkBubbleState | null) => void,
  setIsEditingLink: (v: boolean) => void
): {
  handleLinkSave: (href: string) => void
  handleLinkRemove: () => void
  handleLinkEditCancel: () => void
  handleLinkCopy: () => void
  toggleLinkFromToolbar: () => void
  cancelHoverBubble: () => void
  onBubblePointerEnter: React.PointerEventHandler<HTMLDivElement>
  onBubblePointerLeave: React.PointerEventHandler<HTMLDivElement>
} {
  const containerElement = editor && !editor.isDestroyed ? editor.view.dom : rootRef.current
  const { cancelHoverBubble, onBubblePointerEnter, onBubblePointerLeave } =
    useMarkdownLinkHoverBubble({
      containerElement,
      isOpen: linkBubble !== null,
      isEditing: isEditingLink,
      findLinkElement: (target) => findRichMarkdownHoveredLinkElement(editor, target),
      resolveLinkBubble: (linkElement, point) =>
        resolveRichMarkdownHoveredLinkBubble(editor, linkElement, point),
      setLinkBubble
    })

  useEffect(() => {
    if (!editor) {
      return
    }
    const dismissStaleBubble = ({ transaction }: EditorEvents['transaction']): void => {
      if (transaction.docChanged) {
        cancelHoverBubble()
        setLinkBubble(null)
        setIsEditingLink(false)
      }
    }
    editor.on('transaction', dismissStaleBubble)
    return () => {
      editor.off('transaction', dismissStaleBubble)
    }
  }, [cancelHoverBubble, editor, setIsEditingLink, setLinkBubble])

  const startLinkEdit = useCallback(() => {
    if (!editor) {
      return
    }
    const selectionBubble = getRichMarkdownSelectionLinkBubble(editor, rootRef.current)
    if (selectionBubble && selectionBubble.kind === 'markdown') {
      cancelHoverBubble()
      setLinkBubble(selectionBubble)
      setIsEditingLink(true)
      return
    }
    const pos = getLinkBubblePosition(editor, rootRef.current)
    if (pos) {
      cancelHoverBubble()
      setLinkBubble(createEditableMarkdownLinkBubble('', pos))
      setIsEditingLink(true)
    }
  }, [cancelHoverBubble, editor, rootRef, setIsEditingLink, setLinkBubble])

  const handleLinkSave = useCallback(
    (href: string) => {
      if (!editor) {
        return
      }
      applyRichMarkdownLinkSave(editor, href, linkBubble?.targetRange)
      cancelHoverBubble()
      setIsEditingLink(false)
      setLinkBubble(null)
    },
    [cancelHoverBubble, editor, linkBubble?.targetRange, setIsEditingLink, setLinkBubble]
  )

  const handleLinkRemove = useCallback(() => {
    if (!editor) {
      return
    }
    applyRichMarkdownLinkRemove(editor, linkBubble?.targetRange)
    cancelHoverBubble()
    setLinkBubble(null)
    setIsEditingLink(false)
  }, [cancelHoverBubble, editor, linkBubble?.targetRange, setIsEditingLink, setLinkBubble])

  const handleLinkEditCancel = useCallback(() => {
    cancelHoverBubble()
    setIsEditingLink(false)
    setLinkBubble(null)
    editor?.commands.focus()
  }, [cancelHoverBubble, editor, setIsEditingLink, setLinkBubble])

  const handleLinkCopy = useCallback(() => {
    if (!linkBubble?.href || !linkBubble.copyEnabled) {
      return
    }
    void copyRichMarkdownLink(linkBubble.href)
  }, [linkBubble?.copyEnabled, linkBubble?.href])

  const toggleLinkFromToolbar = useCallback(() => {
    if (!editor) {
      return
    }
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      cancelHoverBubble()
      setLinkBubble(null)
    } else {
      startLinkEdit()
    }
  }, [cancelHoverBubble, editor, setLinkBubble, startLinkEdit])

  return {
    handleLinkSave,
    handleLinkRemove,
    handleLinkEditCancel,
    handleLinkCopy,
    toggleLinkFromToolbar,
    cancelHoverBubble,
    onBubblePointerEnter,
    onBubblePointerLeave
  }
}
