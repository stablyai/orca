import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Link as LinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  insertLinkScaffold,
  isLikelyUrl,
  wrapSelectionAsLink,
  type TextEdit
} from './todo-notes-link'

// Why: autosave once the user pauses; blur flushes immediately. Shared by the
// inline sidebar panel and the full page so link-embedding behaves identically.
const AUTOSAVE_DEBOUNCE_MS = 800

type TodoNotesDocEditorProps = {
  value: string
  autoFocus: boolean
  onSave: (body: string) => Promise<boolean>
  onDone: () => void
  placeholder: string
  minHeightClassName?: string
}

export function TodoNotesDocEditor({
  value,
  autoFocus,
  onSave,
  onDone,
  placeholder,
  minHeightClassName
}: TodoNotesDocEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why: after a programmatic edit (paste-wrap / link button) we must restore the
  // caret/selection, which a controlled textarea drops on re-render.
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null)

  const autoGrow = useCallback((): void => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [])

  useLayoutEffect(() => {
    autoGrow()
    const sel = pendingSelectionRef.current
    const el = textareaRef.current
    if (sel && el) {
      el.focus()
      el.setSelectionRange(sel.start, sel.end)
      pendingSelectionRef.current = null
    }
  }, [draft, autoGrow])

  const clearPending = (): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }

  const persist = async (next: string): Promise<void> => {
    clearPending()
    // Why: bind disabled immediately so a slow round-trip can't overlap saves;
    // skip no-op writes.
    if (busy || next === value) {
      return
    }
    setBusy(true)
    try {
      await onSave(next)
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  const scheduleSave = (next: string): void => {
    clearPending()
    debounceRef.current = setTimeout(() => void persist(next), AUTOSAVE_DEBOUNCE_MS)
  }

  const applyEdit = (edit: TextEdit): void => {
    setDraft(edit.text)
    pendingSelectionRef.current = { start: edit.selectionStart, end: edit.selectionEnd }
    scheduleSave(edit.text)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const clip = e.clipboardData.getData('text')
    const el = textareaRef.current
    if (!el) {
      return
    }
    const { selectionStart, selectionEnd } = el
    // Why: select text + paste a URL → wrap as a markdown link. A bare URL with
    // no selection falls through to the default paste (GFM auto-links on render).
    if (isLikelyUrl(clip) && selectionEnd > selectionStart) {
      e.preventDefault()
      applyEdit(wrapSelectionAsLink(draft, selectionStart, selectionEnd, clip))
    }
  }

  const onLinkClick = (): void => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    applyEdit(insertLinkScaffold(draft, el.selectionStart, el.selectionEnd))
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="todo-notes-doc-link"
          disabled={busy}
          // Why: preventDefault on mousedown keeps the textarea focused/selected so
          // the button click can wrap the current selection (and doesn't blur-save).
          onMouseDown={(e) => e.preventDefault()}
          onClick={onLinkClick}
          className="text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.todos.TodoNotesDocEditor.link',
            'Insert link'
          )}
          title={translate(
            'auto.components.right.sidebar.todos.TodoNotesDocEditor.link',
            'Insert link'
          )}
        >
          <LinkIcon className="size-3" />
        </Button>
      </div>
      <textarea
        ref={textareaRef}
        data-testid="todo-notes-doc-input"
        value={draft}
        disabled={busy}
        autoFocus={autoFocus}
        onChange={(e) => {
          setDraft(e.target.value)
          scheduleSave(e.target.value)
        }}
        onBlur={() => {
          clearPending()
          void persist(draft)
          if (mountedRef.current) {
            onDone()
          }
        }}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            clearPending()
            setDraft(value)
            onDone()
          }
        }}
        placeholder={placeholder}
        className={cn(
          'w-full resize-none overflow-hidden rounded-sm border border-input bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/50 disabled:opacity-50',
          minHeightClassName ?? 'min-h-[64px]'
        )}
      />
    </div>
  )
}
