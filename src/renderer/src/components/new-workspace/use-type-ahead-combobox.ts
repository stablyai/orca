import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useWheelScrollable } from './use-wheel-scrollable'

/**
 * The machinery shared by the composer's type-ahead pickers (Project, Run on):
 * the field is the search box, exactly one row is armed at a time, and Enter
 * takes it.
 *
 * Two subtleties worth keeping:
 * - Armed is tracked by row *key*, not index, so a list arriving late over SSH
 *   cannot slide a different row under a keypress the user already aimed. The
 *   query it was aimed at rides along, so a newer query drops a stale arm
 *   during render rather than needing a reset effect.
 * - Closing without committing clears the query, or the field is left showing
 *   text that matches nothing while hiding the committed selection.
 */
export function useTypeAheadCombobox(deriveRowKeys: (query: string) => readonly string[]): {
  query: string
  setQuery: (value: string) => void
  open: boolean
  setOpen: (open: boolean) => void
  /** Clears the query and closes — the "back out without committing" path. */
  close: () => void
  /** Radix `onOpenChange`: closing always drops an uncommitted query. */
  handleOpenChange: (next: boolean) => void
  /** Row keys for the current query, as returned by `deriveRowKeys`. */
  rowKeys: readonly string[]
  armedKey: string | null
  arm: (key: string) => void
  /** Moves the arm by `step` rows, clamped to the ends. */
  moveArm: (step: number) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  listId: string
  /** Ref callback for the scroll pane; also restores wheel scrolling. */
  setListNode: (node: HTMLDivElement | null) => void
} {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState<{ key: string; query: string } | null>(null)
  const rowKeys = deriveRowKeys(query)
  const inputRef = useRef<HTMLInputElement>(null)
  // react-remove-scroll (Radix Dialog) cancels wheel events for this portaled
  // pane, so the list has to scroll itself.
  const { ref: listRef, setNode: setListNode } = useWheelScrollable<HTMLDivElement>()
  const listId = React.useId()

  // A stale arm (aimed at an earlier query) falls back to the first row.
  const armedKey = armed !== null && armed.query === query ? armed.key : null
  const armedIndex = Math.max(armedKey === null ? -1 : rowKeys.indexOf(armedKey), 0)
  const resolvedKey = rowKeys[armedIndex] ?? null

  React.useEffect(() => {
    if (open) {
      listRef.current?.querySelector('[data-armed="true"]')?.scrollIntoView({ block: 'nearest' })
    }
  }, [listRef, open, armedIndex, rowKeys.length])

  const arm = useCallback(
    // `query` is read at call time; the closure refreshes each render.
    (key: string) => setArmed({ key, query }),
    [query]
  )

  const moveArm = useCallback(
    (step: number): void => {
      const next = rowKeys[Math.min(Math.max(armedIndex + step, 0), rowKeys.length - 1)]
      if (next !== undefined) {
        setArmed({ key: next, query })
      }
    },
    [armedIndex, query, rowKeys]
  )

  const close = useCallback((): void => {
    setOpen(false)
    setQuery('')
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        setOpen(true)
        return
      }
      close()
    },
    [close]
  )

  return useMemo(
    () => ({
      query,
      setQuery,
      open,
      setOpen,
      close,
      handleOpenChange,
      rowKeys,
      armedKey: resolvedKey,
      arm,
      moveArm,
      inputRef,
      listId,
      setListNode
    }),
    [arm, close, handleOpenChange, listId, moveArm, open, query, resolvedKey, rowKeys, setListNode]
  )
}

/** True when an event target lies inside the control marked by `rootAttribute`. */
export function isWithinComboboxRoot(target: EventTarget | null, rootAttribute: string): boolean {
  return target instanceof Element && target.closest(`[${rootAttribute}="true"]`) !== null
}
