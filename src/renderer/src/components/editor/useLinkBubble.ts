import { useCallback } from 'react'
import type { Editor } from '@tiptap/react'
import { getLinkBubblePosition } from './RichMarkdownLinkBubble'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import { useAppStore } from '@/store'

/**
 * Extracts link-editing action handlers from the editor component to reduce
 * file size. State lives in the parent (declared before useEditor so the
 * editor callbacks can reference the setters).
 */
export function useLinkBubble(
  editor: Editor | null,
  rootRef: React.RefObject<HTMLElement | null>,
  linkBubble: LinkBubbleState | null,
  setLinkBubble: (v: LinkBubbleState | null) => void,
  setIsEditingLink: (v: boolean) => void,
  linkContext: {
    sourceFilePath: string
    worktreeId: string
    worktreeRoot: string | null
  }
): {
  handleLinkSave: (href: string) => void
  handleLinkRemove: () => void
  handleLinkEditCancel: () => void
  handleLinkOpen: () => void
  toggleLinkFromToolbar: () => void
} {
  const startLinkEdit = useCallback(() => {
    if (!editor) {
      return
    }
    const pos = getLinkBubblePosition(editor, rootRef.current)
    if (pos) {
      const href = editor.isActive('link')
        ? (editor.getAttributes('link').href as string) || ''
        : ''
      setLinkBubble({ href, ...pos })
      setIsEditingLink(true)
    }
  }, [editor, rootRef, setLinkBubble, setIsEditingLink])

  const handleLinkSave = useCallback(
    (href: string) => {
      if (!editor) {
        return
      }

      if (href) {
        if (editor.isActive('link')) {
          editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
        } else {
          const { from, to } = editor.state.selection
          if (from === to) {
            // No selection: insert URL as both the link text and href.
            editor
              .chain()
              .focus()
              .insertContent({
                type: 'text',
                text: href,
                marks: [{ type: 'link', attrs: { href } }]
              })
              .run()
          } else {
            editor.chain().focus().setLink({ href }).run()
          }
        }
      } else if (editor.isActive('link')) {
        editor.chain().focus().extendMarkRange('link').unsetLink().run()
      } else {
        editor.commands.focus()
      }
      setIsEditingLink(false)
    },
    [editor, setIsEditingLink]
  )

  const handleLinkRemove = useCallback(() => {
    if (!editor) {
      return
    }
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinkBubble(null)
    setIsEditingLink(false)
  }, [editor, setLinkBubble, setIsEditingLink])

  const handleLinkEditCancel = useCallback(() => {
    setIsEditingLink(false)
    if (!linkBubble?.href) {
      setLinkBubble(null)
    }
    editor?.commands.focus()
  }, [editor, linkBubble?.href, setLinkBubble, setIsEditingLink])

  const activateMarkdownLink = useAppStore((s) => s.activateMarkdownLink)

  const handleLinkOpen = useCallback(() => {
    if (!linkBubble?.href) {
      return
    }
    void activateMarkdownLink(linkBubble.href, {
      sourceFilePath: linkContext.sourceFilePath,
      worktreeId: linkContext.worktreeId,
      worktreeRoot: linkContext.worktreeRoot
    })
  }, [
    activateMarkdownLink,
    linkBubble?.href,
    linkContext.sourceFilePath,
    linkContext.worktreeId,
    linkContext.worktreeRoot
  ])

  const toggleLinkFromToolbar = useCallback(() => {
    if (!editor) {
      return
    }
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      setLinkBubble(null)
    } else {
      startLinkEdit()
    }
  }, [editor, setLinkBubble, startLinkEdit])

  return {
    handleLinkSave,
    handleLinkRemove,
    handleLinkEditCancel,
    handleLinkOpen,
    toggleLinkFromToolbar
  }
}
