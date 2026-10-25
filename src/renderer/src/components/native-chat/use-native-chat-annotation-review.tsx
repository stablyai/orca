import { useMemo, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Pencil, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useNativeChatAnnotationLocate,
  type NativeChatAnnotationNavigation
} from './use-native-chat-annotation-locate'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { nativeChatAnnotationCopy } from './native-chat-annotation-copy'
import type { NativeChatAnnotationAnchor } from './native-chat-annotation-anchor'
import {
  useNativeChatAnnotations,
  useNativeChatAnnotationHighlights,
  type NativeChatAnnotation
} from './use-native-chat-annotations'
import { NativeChatAnnotationOverlay } from './NativeChatAnnotationOverlay'

export function useNativeChatAnnotationReview({
  scopeKey,
  rootRef,
  composerRef,
  enabled,
  messageListRef
}: {
  scopeKey?: string
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  enabled: boolean
  messageListRef?: RefObject<NativeChatAnnotationNavigation | null>
}) {
  useTranslation()
  const review = useNativeChatAnnotations(scopeKey)
  const editor = review.editor
  const highlightNotes = useMemo(
    () =>
      editor
        ? [
            ...review.notes.filter((note) => note.id !== editor.id),
            { ...editor.anchor, id: 'editor', comment: editor.comment, createdAt: 0 }
          ]
        : review.notes,
    [editor, review.notes]
  )
  const highlightName = useNativeChatAnnotationHighlights(rootRef, highlightNotes, enabled)
  const [expanded, setExpanded] = useState(false)
  const { locate, missingOriginal, resetMissingOriginal } = useNativeChatAnnotationLocate(
    rootRef,
    scopeKey,
    enabled,
    messageListRef
  )
  const copy = nativeChatAnnotationCopy()
  const save = (): void => {
    if (!editor?.comment.trim()) {
      return
    }
    if (!editor.id || !review.update(editor.id, editor.comment)) {
      review.add(editor.anchor, editor.comment)
    }
    review.setEditor(undefined)
  }
  const begin = (anchor: NativeChatAnnotationAnchor): void => {
    if (!scopeKey) {
      return
    }
    save()
    review.setEditor({ anchor, comment: '' })
    setExpanded(false)
    resetMissingOriginal()
    window.getSelection()?.removeAllRanges()
  }
  const edit = (note: NativeChatAnnotation): void => {
    save()
    review.setEditor({ anchor: note, id: note.id, comment: note.comment })
    setExpanded(false)
    locate(note)
  }
  const count = review.notes.length
  const iconButton = (label: string, icon: ReactNode, action: () => void) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={action}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
  return {
    begin: scopeKey ? begin : undefined,
    tray:
      scopeKey && enabled && (count > 0 || editor || review.persistenceError) ? (
        <div data-native-chat-annotations="" className="px-2 pt-1 text-sm text-foreground">
          <style>{`::highlight(${highlightName}) { background-color: color-mix(in srgb, var(--chat-annotation) 30%, transparent); color: inherit; }`}</style>
          {count > 0 ? (
            <Popover open={expanded} onOpenChange={setExpanded}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="max-w-full"
                  aria-label={copy.count(count)}
                >
                  <MessageSquare />
                  <span className="truncate">{copy.count(count)}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                portalContainer={rootRef.current}
                aria-label={copy.title}
                role="region"
                align="start"
                side="top"
                collisionPadding={12}
                className="w-96 max-w-[calc(100vw-1.5rem)]"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                <ol className="scrollbar-sleek max-h-64 divide-y divide-border overflow-y-auto overscroll-contain p-2 text-sm">
                  {review.notes.map((note, index) => (
                    <li key={note.id} className="py-2">
                      <div className="flex items-start gap-2">
                        <span className="pt-1 text-xs text-muted-foreground">{index + 1}.</span>
                        <button
                          type="button"
                          aria-label={copy.locate}
                          className="min-w-0 flex-1 border-l-2 border-border pl-2 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => locate(note)}
                        >
                          <span className="line-clamp-3 whitespace-pre-wrap break-words">
                            {note.quote}
                          </span>
                        </button>
                        <div className="flex shrink-0">
                          {iconButton(copy.edit, <Pencil />, () => edit(note))}
                          {iconButton(copy.remove, <Trash2 />, () => review.remove(note.id))}
                        </div>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words pl-5 text-sm">
                        {note.comment}
                      </p>
                    </li>
                  ))}
                </ol>
                {missingOriginal ? (
                  <p role="status" className="py-1 text-xs text-muted-foreground">
                    {copy.originalUnavailable}
                  </p>
                ) : null}
              </PopoverContent>
            </Popover>
          ) : null}
          {review.persistenceError ? (
            <div className="flex items-center gap-1 py-1 text-xs text-chat-warning">
              <p role="status" className="min-w-0 flex-1">
                {copy.notSaved}
              </p>
              {iconButton(copy.retry, <RotateCw />, () => {
                review.retryPersistence()
              })}
            </div>
          ) : null}
          <NativeChatAnnotationOverlay
            rootRef={rootRef}
            notes={review.notes}
            editor={editor}
            onEdit={edit}
            onChange={review.setEditor}
            onSave={save}
            onClose={() => {
              review.setEditor(undefined)
              composerRef.current?.focus()
            }}
          />
        </div>
      ) : null
  }
}
