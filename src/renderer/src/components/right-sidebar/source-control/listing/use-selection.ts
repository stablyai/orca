import { useState, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlRowOpenEvent } from './split-open'

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export type FlatEntry = {
  key: string
  entry: GitStatusEntry
  area: 'unstaged' | 'staged' | 'untracked'
}

export function reconcileSourceControlSelectionState(args: {
  selectedKeys: ReadonlySet<string>
  anchorKey: string | null
  flatEntries: FlatEntry[]
}): { selectedKeys: ReadonlySet<string>; anchorKey: string | null } {
  const { anchorKey, flatEntries, selectedKeys } = args
  // Nothing to prune and no anchor to invalidate: skip building the key set over every visible row.
  if (selectedKeys.size === 0 && anchorKey === null) {
    return { selectedKeys, anchorKey }
  }
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

  // Memoize reconciliation across keystrokes/polls; only selected/anchor/row references can change it.
  const reconciledSelection = useMemo(
    () => reconcileSourceControlSelectionState({ selectedKeys, anchorKey, flatEntries }),
    [selectedKeys, anchorKey, flatEntries]
  )
  if (reconciledSelection.selectedKeys !== selectedKeys) {
    // Prune disappeared rows before children receive stale bulk-action keys.
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

      // If the anchor disappeared, Shift-click falls back to a plain click instead of selecting from an invisible row.
      setSelectedKeys(new Set())
      setAnchorKey(key)
      onOpenDiffRef.current(entry)
    } else if (isCmdOrCtrl) {
      if (selectedKeysRef.current.has(key)) {
        setSelectedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      } else {
        setSelectedKeys((prev) => {
          const next = new Set(prev)
          next.add(key)
          return next
        })
        setAnchorKey(key)
      }
    } else {
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

    // Clear outside selections during capture before the destination surface handles the pointer.
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
