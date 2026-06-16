import { useState, useCallback, useEffect, useRef, type RefObject } from 'react'
import type { GitStatusEntry } from '../../../../shared/types'
import type { SourceControlRowOpenEvent } from './source-control-split-open'

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export type FlatEntry = {
  key: string
  entry: GitStatusEntry
  area: 'unstaged' | 'staged' | 'untracked'
}

export function reconcileSelectionKeys(
  selectedKeys: ReadonlySet<string>,
  flatEntries: FlatEntry[]
): Set<string> {
  const validKeys = new Set(flatEntries.map((e) => e.key))
  const nextSelected = new Set<string>()

  for (const key of selectedKeys) {
    if (validKeys.has(key)) {
      nextSelected.add(key)
    }
  }

  return nextSelected
}

export function reconcileSourceControlSelectionState(args: {
  selectedKeys: ReadonlySet<string>
  anchorKey: string | null
  flatEntries: FlatEntry[]
}): { selectedKeys: ReadonlySet<string>; anchorKey: string | null } {
  const { anchorKey, flatEntries, selectedKeys } = args
  const validKeys = new Set(flatEntries.map((e) => e.key))
  const nextSelected = new Set<string>()
  let selectedChanged = false

  for (const key of selectedKeys) {
    if (validKeys.has(key)) {
      nextSelected.add(key)
    } else {
      selectedChanged = true
    }
  }

  return {
    selectedKeys: selectedChanged ? nextSelected : selectedKeys,
    anchorKey: anchorKey && !validKeys.has(anchorKey) ? null : anchorKey
  }
}

export function getSelectionRangeKeys(
  flatEntries: FlatEntry[],
  anchorKey: string | null,
  currentKey: string
): Set<string> | null {
  const anchorIndex = flatEntries.findIndex((e) => e.key === anchorKey)
  const currentIndex = flatEntries.findIndex((e) => e.key === currentKey)
  if (anchorIndex === -1 || currentIndex === -1) {
    return null
  }

  const start = Math.min(anchorIndex, currentIndex)
  const end = Math.max(anchorIndex, currentIndex)
  const nextSelected = new Set<string>()
  for (let i = start; i <= end; i++) {
    nextSelected.add(flatEntries[i].key)
  }
  return nextSelected
}

export function useSourceControlSelection({
  flatEntries,
  onOpenDiff,
  shouldOpenAsSplit,
  containerRef
}: {
  flatEntries: FlatEntry[]
  onOpenDiff: (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => void
  shouldOpenAsSplit?: (event: SourceControlRowOpenEvent) => boolean
  containerRef: RefObject<HTMLElement | null>
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [anchorKey, setAnchorKey] = useState<string | null>(null)
  const flatEntriesRef = useRef(flatEntries)
  const anchorKeyRef = useRef<string | null>(anchorKey)
  const selectedKeysRef = useRef(selectedKeys)
  const onOpenDiffRef = useRef(onOpenDiff)
  const shouldOpenAsSplitRef = useRef(shouldOpenAsSplit)

  useEffect(() => {
    flatEntriesRef.current = flatEntries
  }, [flatEntries])

  useEffect(() => {
    anchorKeyRef.current = anchorKey
  }, [anchorKey])

  useEffect(() => {
    selectedKeysRef.current = selectedKeys
  }, [selectedKeys])

  useEffect(() => {
    onOpenDiffRef.current = onOpenDiff
  }, [onOpenDiff])

  useEffect(() => {
    shouldOpenAsSplitRef.current = shouldOpenAsSplit
  }, [shouldOpenAsSplit])

  const reconciledSelection = reconcileSourceControlSelectionState({
    selectedKeys,
    anchorKey,
    flatEntries
  })
  if (reconciledSelection.selectedKeys !== selectedKeys) {
    // Why: visible source-control rows can disappear after filtering, staging,
    // or status refresh; prune stale bulk-action keys before children see them.
    setSelectedKeys(new Set(reconciledSelection.selectedKeys))
  }
  if (reconciledSelection.anchorKey !== anchorKey) {
    setAnchorKey(reconciledSelection.anchorKey)
  }

  const handleSelect = useCallback((e: React.MouseEvent, key: string, entry: GitStatusEntry) => {
    if (shouldOpenAsSplitRef.current?.(e)) {
      setSelectedKeys((prev) => (prev.size > 0 ? new Set() : prev))
      setAnchorKey(null)
      onOpenDiffRef.current(entry, e)
      return
    }

    const isShift = e.shiftKey
    const isCmdOrCtrl = isMacPlatform() ? e.metaKey : e.ctrlKey

    if (isShift) {
      const nextSelected = getSelectionRangeKeys(flatEntriesRef.current, anchorKeyRef.current, key)
      if (nextSelected) {
        setSelectedKeys(nextSelected)
        return
      }

      // Why: when the anchor row disappears from the visible list because a
      // section collapsed or status changed, the next Shift-click should
      // fall back to the single-click behavior instead of selecting from a
      // stale invisible anchor.
      setSelectedKeys(new Set())
      setAnchorKey(key)
      onOpenDiffRef.current(entry)
    } else if (isCmdOrCtrl) {
      // Toggle individual
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) {
          next.delete(key)
          // Keep anchorKey as is
        } else {
          next.add(key)
          setAnchorKey(key)
        }
        return next
      })
    } else {
      // Plain click
      setSelectedKeys((prev) => {
        if (prev.size > 0) {
          return new Set()
        }
        return prev
      })
      setAnchorKey(key)
      onOpenDiffRef.current(entry)
    }
  }, [])

  const handleContextMenu = useCallback((key: string) => {
    if (!selectedKeysRef.current.has(key)) {
      setSelectedKeys(new Set([key]))
      setAnchorKey(key)
    }
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set())
    setAnchorKey(null)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedKeys.size > 0) {
        e.preventDefault()
        clearSelection()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedKeys.size, clearSelection])

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (selectedKeys.size === 0) {
        return
      }

      const container = containerRef.current
      const target = e.target
      if (!container || !(target instanceof Node) || container.contains(target)) {
        return
      }

      clearSelection()
    }

    // Why: use capture so outside clicks clear the selection before the next
    // UI surface handles the pointer event, matching standard desktop list UX.
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [selectedKeys.size, containerRef, clearSelection])

  return {
    selectedKeys,
    handleSelect,
    handleContextMenu,
    clearSelection
  }
}
