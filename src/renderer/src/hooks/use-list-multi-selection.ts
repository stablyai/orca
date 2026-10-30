import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import {
  areSelectionsEqual,
  getSelectionIntent,
  pruneSelection,
  updateSelection
} from '@/lib/list-multi-selection'
import { useReusedArrayIdentity } from '@/components/sidebar/worktree-list/listing/use-reused-array-identity'

export type ListMultiSelection<T> = {
  visibleKeys: string[]
  selectedKeys: Set<string>
  selectedItems: T[]
  /** Returns true for selection-only gestures (Cmd/Ctrl/Shift), which must not navigate. */
  updateSelectionForGesture: (
    event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
    item: T
  ) => boolean
  /** Right-click inside a 2+ selection acts on all of it; elsewhere it resets to the item. */
  selectForContextMenu: (item: T) => readonly T[]
}

// Keep getKey/getScope identities stable while selecting by render order.
export function useListMultiSelection<T>({
  items,
  getKey,
  getScope
}: {
  items: readonly T[]
  getKey: (item: T) => string
  /** Pointerdowns outside this element clear the selection. */
  getScope: () => Element | null
}): ListMultiSelection<T> {
  // Reuse equal ordered-ID arrays so gesture callbacks stay stable and row memoization survives epoch bumps.
  const visibleKeys = useReusedArrayIdentity(
    useMemo(() => Array.from(new Set(items.map((item) => getKey(item)))), [items, getKey])
  )
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null)

  const prunedSelection = pruneSelection(selectedKeys, selectionAnchorKey, visibleKeys)
  // Why: filters/grouping can hide selected rows; prune during render so nothing sees stale ids for unrendered items.
  if (!areSelectionsEqual(selectedKeys, prunedSelection.selectedIds)) {
    setSelectedKeys(prunedSelection.selectedIds)
  }
  if (selectionAnchorKey !== prunedSelection.anchorId) {
    setSelectionAnchorKey(prunedSelection.anchorId)
  }

  // Reuse empty/unchanged selections so context-menu/drag callbacks and row memoization remain stable.
  const selectedItems = useReusedArrayIdentity(
    useMemo(() => {
      if (selectedKeys.size === 0) {
        return []
      }
      const selected = new Map<string, T>()
      for (const item of items) {
        const key = getKey(item)
        if (selectedKeys.has(key) && !selected.has(key)) {
          selected.set(key, item)
        }
      }
      return Array.from(selected.values())
    }, [items, getKey, selectedKeys])
  )

  useEffect(() => {
    if (selectedKeys.size === 0) {
      return
    }

    const clearSelectionOutsideScope = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && getScope()?.contains(target)) {
        return
      }
      setSelectedKeys(new Set())
      setSelectionAnchorKey(null)
    }

    document.addEventListener('pointerdown', clearSelectionOutsideScope, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', clearSelectionOutsideScope, { capture: true })
    }
  }, [selectedKeys.size, getScope])

  // Why read through a ref: every plain click replaces the selection, and selection-keyed callbacks would re-render every memoized row.
  const latestSelectionRef = useRef({
    visibleKeys,
    selectedKeys,
    selectionAnchorKey,
    selectedItems
  })
  useLayoutEffect(() => {
    latestSelectionRef.current = { visibleKeys, selectedKeys, selectionAnchorKey, selectedItems }
  })

  const updateSelectionForGesture = useCallback(
    (event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>, item: T): boolean => {
      const latest = latestSelectionRef.current
      const intent = getSelectionIntent(event, navigator.userAgent.includes('Mac'))
      const result = updateSelection({
        visibleIds: latest.visibleKeys,
        previousSelectedIds: latest.selectedKeys,
        previousAnchorId: latest.selectionAnchorKey,
        targetId: getKey(item),
        intent
      })
      setSelectedKeys(result.selectedIds)
      setSelectionAnchorKey(result.anchorId)
      // Plain click navigates; modifier gestures are selection-only so a batch can build without switching away.
      return intent !== 'replace'
    },
    [getKey]
  )

  const selectForContextMenu = useCallback(
    (item: T): readonly T[] => {
      const latest = latestSelectionRef.current
      const key = getKey(item)
      if (latest.selectedKeys.has(key) && latest.selectedKeys.size > 1) {
        return latest.selectedItems
      }
      setSelectedKeys(new Set([key]))
      setSelectionAnchorKey(key)
      return [item]
    },
    [getKey]
  )

  return {
    visibleKeys,
    selectedKeys,
    selectedItems,
    updateSelectionForGesture,
    selectForContextMenu
  }
}
