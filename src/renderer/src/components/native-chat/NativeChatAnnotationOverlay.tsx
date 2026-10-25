import { useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { resolveNativeChatAnnotationRange } from './native-chat-annotation-anchor'
import type {
  NativeChatAnnotation,
  NativeChatAnnotationEditor
} from './native-chat-annotations-store'
import { nativeChatAnnotationCopy } from './native-chat-annotation-copy'

export function NativeChatAnnotationOverlay({
  rootRef,
  notes,
  editor,
  onEdit,
  onChange,
  onSave,
  onClose
}: {
  rootRef: RefObject<HTMLElement | null>
  notes: readonly NativeChatAnnotation[]
  editor?: NativeChatAnnotationEditor
  onEdit: (note: NativeChatAnnotation) => void
  onChange: (editor: NativeChatAnnotationEditor) => void
  onSave: () => void
  onClose: () => void
}): React.JSX.Element {
  useTranslation()
  const [positions, setPositions] = useState<readonly { id: string; x: number; y: number }[]>([])
  const [editorRect, setEditorRect] = useState<DOMRect | null>(null)
  const markerNotes = useMemo(
    () =>
      editor && !notes.some((note) => note.id === editor.id)
        ? [...notes, { ...editor.anchor, id: 'draft', comment: editor.comment, createdAt: 0 }]
        : notes,
    [notes, editor]
  )
  const copy = nativeChatAnnotationCopy()
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    let frame = 0
    const measure = (): void => {
      frame = 0
      const viewport =
        root.querySelector('[data-native-chat-scroll]')?.getBoundingClientRect() ??
        root.getBoundingClientRect()
      const next = markerNotes.flatMap((note) => {
        const range = resolveNativeChatAnnotationRange(root, note)
        const rect = range?.getBoundingClientRect?.()
        if (
          !rect ||
          rect.width === 0 ||
          rect.bottom <= viewport.top ||
          rect.top >= viewport.bottom
        ) {
          return []
        }
        return [
          {
            id: note.id,
            x: Math.max(viewport.left + 12, Math.min(rect.right, viewport.right - 16)),
            y: Math.max(viewport.top + 12, rect.top)
          }
        ]
      })
      setPositions((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      )
      const range = editor ? resolveNativeChatAnnotationRange(root, editor.anchor) : null
      const rect = range?.getBoundingClientRect?.()
      const fallback = root.getBoundingClientRect()
      const nextRect =
        rect && rect.bottom > viewport.top && rect.top < viewport.bottom
          ? rect
          : new DOMRect(fallback.left + 16, viewport.bottom - 16, 0, 0)
      setEditorRect((previous) =>
        previous?.x === nextRect.x &&
        previous.y === nextRect.y &&
        previous.width === nextRect.width &&
        previous.height === nextRect.height
          ? previous
          : nextRect
      )
    }
    const schedule = (): void => {
      if (!frame) {
        frame = requestAnimationFrame(measure)
      }
    }
    measure()
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !(
              record.target instanceof Element ? record.target : record.target.parentElement
            )?.closest('[data-native-chat-annotations], [data-native-chat-annotation-overlay]')
        )
      ) {
        schedule()
      }
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    root.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      observer.disconnect()
      resize.disconnect()
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [rootRef, markerNotes, editor])
  const virtualRef = useMemo(
    () => ({ current: { getBoundingClientRect: () => editorRect ?? new DOMRect() } }),
    [editorRect]
  )
  return (
    <>
      {rootRef.current
        ? createPortal(
            <div data-native-chat-annotation-overlay="">
              {positions.map((position) => {
                const index = markerNotes.findIndex((note) => note.id === position.id)
                const note = markerNotes[index]
                if (!note) {
                  return null
                }
                return (
                  <Tooltip key={note.id}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-xs-round"
                        variant="annotation-marker"
                        data-native-chat-annotation-marker={index + 1}
                        aria-label={`${copy.edit} ${index + 1}`}
                        className="fixed z-40 -translate-x-1/2 -translate-y-1/2"
                        style={{ left: position.x, top: position.y }}
                        onClick={() => {
                          if (note.id !== 'draft') {
                            onEdit(note)
                          }
                        }}
                      >
                        {index + 1}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{note.comment}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>,
            rootRef.current
          )
        : null}
      <Popover
        open={editor !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            onClose()
          }
        }}
      >
        <PopoverAnchor virtualRef={virtualRef} />
        {editor ? (
          <PopoverContent
            portalContainer={rootRef.current}
            data-native-chat-annotation-overlay=""
            aria-label={copy.comment}
            align="start"
            side="top"
            sideOffset={12}
            collisionPadding={12}
            variant="annotation"
            className="w-80 max-w-[calc(100vw-1.5rem)]"
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <form
              className="flex items-start gap-1 p-2"
              onSubmit={(event) => {
                event.preventDefault()
                onSave()
              }}
            >
              <Textarea
                autoFocus
                aria-label={copy.comment}
                placeholder={copy.comment}
                rows={1}
                value={editor.comment}
                variant="annotation"
                className="max-h-40 flex-1 field-sizing-content"
                onChange={(event) => onChange({ ...editor, comment: event.target.value })}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) {
                    return
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    onSave()
                  }
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs-round"
                    aria-label={copy.cancel}
                    onClick={onClose}
                  >
                    <X />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copy.cancel}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="submit"
                    size="icon-xs-round"
                    aria-label={copy.save}
                    disabled={!editor.comment.trim()}
                  >
                    <Check />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copy.save}</TooltipContent>
              </Tooltip>
            </form>
          </PopoverContent>
        ) : null}
      </Popover>
    </>
  )
}
