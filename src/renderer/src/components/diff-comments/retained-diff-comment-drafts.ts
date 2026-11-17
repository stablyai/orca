import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'

type RetainedField = {
  body: string
  selectionStart: number
  selectionEnd: number
  selectionDirection: 'forward' | 'backward' | 'none'
  focused: boolean
}

// Why bounded: a draft left open in a closed tab has no owner left to clear it.
const MAX_RETAINED_ENTRIES = 128
const retainedFields = new Map<string, RetainedField>()
type RetainedTarget = { target: object | null; owner: DiffCommentOwner | null }
const retainedTargets = new Map<string, RetainedTarget>()

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_RETAINED_ENTRIES) {
    map.delete(map.keys().next().value!)
  }
}

/** A composer target kept outside its row, so virtualization or a tab switch cannot drop it. */
export function readRetainedDiffCommentTarget(key: string): RetainedTarget | undefined {
  return retainedTargets.get(key)
}

export function writeRetainedDiffCommentTarget(key: string, value: RetainedTarget): void {
  if (value.target) {
    remember(retainedTargets, key, value)
  } else {
    retainedTargets.delete(key)
  }
}

function isRendered(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0
}

// Never take focus from something the user moved to; only reclaim it from the page body.
function canReclaimFocus(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

function restoreField(textarea: HTMLTextAreaElement, field: RetainedField, focus: boolean): void {
  if (focus) {
    textarea.focus({ preventScroll: true })
  }
  const end = Math.min(field.selectionEnd, textarea.value.length)
  textarea.setSelectionRange(Math.min(field.selectionStart, end), end, field.selectionDirection)
}

/**
 * Keeps a note textarea's text, caret and focus outside the row that renders it. Rows unmount
 * when virtualized away or when their tab is hidden, and a row Pierre scrolls out of its window
 * stays mounted but unrendered, which drops focus.
 */
export function useRetainedDiffCommentField(key: string | undefined) {
  const [initial] = useState(() => (key ? retainedFields.get(key) : undefined))
  const keyRef = useRef(key)
  useLayoutEffect(() => {
    keyRef.current = key
  }, [key])
  const canonicalBody = useRef<string | undefined>(undefined)
  const restoredRef = useRef(false)
  const observerRef = useRef<ResizeObserver | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const snapshot = useCallback((focused?: boolean): void => {
    const textarea = textareaRef.current
    const current = keyRef.current
    if (!textarea || !current) {
      return
    }
    remember(retainedFields, current, {
      body: canonicalBody.current ?? textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      selectionDirection: textarea.selectionDirection,
      focused: focused ?? retainedFields.get(current)?.focused ?? false
    })
  }, [])

  const bind = useCallback(
    (textarea: HTMLTextAreaElement | null): void => {
      const previous = textareaRef.current
      if (previous && previous !== textarea) {
        observerRef.current?.disconnect()
        observerRef.current = null
        // Ref detachment precedes removal from the document, so focus is still readable here.
        if (keyRef.current && retainedFields.has(keyRef.current)) {
          snapshot(document.activeElement === previous || undefined)
        }
      }
      textareaRef.current = textarea
      if (!textarea || previous === textarea) {
        return
      }
      if (initial && !restoredRef.current) {
        restoredRef.current = true
        restoreField(textarea, initial, initial.focused && canReclaimFocus())
      }
      if (typeof ResizeObserver !== 'undefined') {
        observerRef.current = new ResizeObserver(() => {
          const field = keyRef.current ? retainedFields.get(keyRef.current) : undefined
          if (field?.focused && isRendered(textarea) && canReclaimFocus()) {
            restoreField(textarea, field, true)
          }
        })
        observerRef.current.observe(textarea)
      }
    },
    [initial, snapshot]
  )

  return useMemo(
    () => ({
      restored: initial !== undefined,
      initialBody: initial?.body,
      bind,
      setBody: (body: string) => {
        canonicalBody.current = body
        snapshot()
      },
      onChange: () => snapshot(),
      onFocus: () => snapshot(true),
      onBlur: () => {
        const textarea = textareaRef.current
        // Losing its box (virtualized away) is not the user leaving the note.
        snapshot(textarea ? !isRendered(textarea) : false)
      },
      clear: () => {
        if (keyRef.current) {
          retainedFields.delete(keyRef.current)
        }
      }
    }),
    [initial, bind, snapshot]
  )
}
