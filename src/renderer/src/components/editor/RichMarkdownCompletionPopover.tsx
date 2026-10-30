import { useMemo, type ReactNode, type Ref } from 'react'
import type { Editor } from '@tiptap/react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useDismissWhenEditorHidden } from './use-dismiss-when-editor-hidden'

type RichMarkdownCompletionPopoverProps = {
  editor: Editor | null
  position: number
  onClose: () => void
  className: string
  role: 'dialog' | 'listbox'
  ariaLabel: string
  viewportRef?: Ref<HTMLDivElement>
  children: ReactNode
}

export function RichMarkdownCompletionPopover({
  editor,
  position,
  onClose,
  className,
  role,
  ariaLabel,
  viewportRef,
  children
}: RichMarkdownCompletionPopoverProps): React.JSX.Element {
  const editorDom = editor && !editor.isDestroyed ? editor.view.dom : null
  useDismissWhenEditorHidden(editorDom, onClose)
  const virtualRef = useMemo(
    () => ({
      current: {
        contextElement: editor && !editor.isDestroyed ? editor.view.dom : undefined,
        getBoundingClientRect: () => {
          if (!editor || editor.isDestroyed) {
            return new DOMRect()
          }
          const cursor = Math.max(0, Math.min(position, editor.state.doc.content.size))
          const coords = editor.view.coordsAtPos(cursor)
          return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
        }
      }
    }),
    [editor, position]
  )

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        asChild
        align="start"
        sideOffset={8}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // Editor clicks and refocus keep the menu; selection sync decides whether it still applies.
        onInteractOutside={(event) => {
          if (event.target instanceof Node && editorDom?.contains(event.target)) {
            event.preventDefault()
          }
        }}
      >
        <div ref={viewportRef} className={className} role={role} aria-label={ariaLabel}>
          {children}
        </div>
      </PopoverContent>
    </Popover>
  )
}
