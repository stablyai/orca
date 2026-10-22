import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { applySshTargetSelectionClick } from './ssh-target-list-model'

export type SshTargetSelection = {
  selected: ReadonlySet<string>
  click: (targetId: string, shiftKey: boolean) => void
  setGroup: (ids: readonly string[], select: boolean) => void
  /** Drops every id not in `ids`; call when the filter changes what is visible. */
  retain: (ids: readonly string[]) => void
  clear: () => void
}

/**
 * Multi-select over the visible SSH host rows, in display order. Only visible ids count, so a
 * bulk action can never reach a host the filter hides or a reload removed.
 */
export function useSshTargetSelection(visibleIds: readonly string[]): SshTargetSelection {
  const [rawSelected, setRawSelected] = useState<ReadonlySet<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  const selected = useMemo(() => {
    const visible = new Set(visibleIds)
    return new Set([...rawSelected].filter((id) => visible.has(id)))
  }, [visibleIds, rawSelected])

  const click = useCallback(
    (targetId: string, shiftKey: boolean): void => {
      // Why read first: the updater may run later (or twice in StrictMode), after the anchor moved.
      const anchorId = anchorRef.current
      setRawSelected((prev) =>
        applySshTargetSelectionClick({
          selected: prev,
          orderedIds: visibleIds,
          anchorId,
          clickedId: targetId,
          shiftKey
        })
      )
      anchorRef.current = targetId
    },
    [visibleIds]
  )

  const setGroup = useCallback((ids: readonly string[], select: boolean): void => {
    setRawSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (select) {
          next.add(id)
        } else {
          next.delete(id)
        }
      }
      return next
    })
  }, [])

  const retain = useCallback((ids: readonly string[]): void => {
    const keep = new Set(ids)
    setRawSelected((prev) => new Set([...prev].filter((id) => keep.has(id))))
  }, [])
  const clear = useCallback((): void => {
    anchorRef.current = null
    setRawSelected(new Set())
  }, [])

  const hasSelection = selected.size > 0
  useEffect(() => {
    if (!hasSelection) {
      return
    }
    // Why capture: Settings closes on a bubbling Escape; with rows selected, Escape clears them first.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || hasVisibleOverlay()) {
        return
      }
      // A filter with text owns the first Escape (it clears the text).
      if (event.target instanceof HTMLInputElement && event.target.value !== '') {
        return
      }
      event.preventDefault()
      clear()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [clear, hasSelection])

  return { selected, click, setGroup, retain, clear }
}
