import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import {
  getCombinedSearchOptionId,
  moveActiveCombinedSearchIndex,
  resolveActiveCombinedSearchIndex,
  type CombinedSearchRow,
  type CombinedSearchRowModel
} from './combined-search-rows'

/** Opens the highlighted row's context menu from the keyboard, as a right click on it would. */
function openActiveRowMenu(activeIndex: number): void {
  const row =
    activeIndex === -1 ? null : document.getElementById(getCombinedSearchOptionId(activeIndex))
  if (!row) {
    return
  }
  const rect = row.getBoundingClientRect()
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 16,
      clientY: rect.top + rect.height / 2
    })
  )
}

/** Focus stays in the field; ↑/↓ move a highlighted row tracked by key so arriving results never shift it. */
export function useCombinedSearchNavigation({
  query,
  model,
  inputRef,
  clearQuery,
  openRow
}: {
  query: string
  model: CombinedSearchRowModel
  inputRef: React.RefObject<HTMLInputElement | null>
  clearQuery: () => void
  openRow: (row: CombinedSearchRow, permanent: boolean) => void
}): {
  activeIndex: number
  activateRow: (row: CombinedSearchRow, index: number, permanent?: boolean) => void
  handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
} {
  const [active, setActive] = useState<{ query: string; key: string | null }>({
    query: '',
    key: null
  })
  const activeKey = active.query === query ? active.key : null
  const activeIndex = useMemo(
    () => resolveActiveCombinedSearchIndex(model, activeKey),
    [activeKey, model]
  )

  const activateRow = useCallback(
    (row: CombinedSearchRow, index: number, permanent = false) => {
      setActive({ query, key: model.getKey(index) })
      openRow(row, permanent)
    },
    [model, openRow, query]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (query) {
          clearQuery()
        } else {
          inputRef.current?.blur()
        }
        return
      }
      if (!query.trim()) {
        return
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        openActiveRowMenu(activeIndex)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = moveActiveCombinedSearchIndex(
          model,
          activeIndex,
          event.key === 'ArrowDown' ? 1 : -1
        )
        if (next !== -1) {
          setActive({ query, key: model.getKey(next) })
        }
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const row = activeIndex === -1 ? undefined : model.getRow(activeIndex)
        if (row) {
          activateRow(row, activeIndex, event.metaKey || event.ctrlKey)
        }
      }
    },
    [activateRow, activeIndex, clearQuery, inputRef, model, query]
  )

  return { activeIndex, activateRow, handleKeyDown }
}
