import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import {
  describePaletteOccurrences,
  type PaletteObservedOccurrence
} from './cmd-j/palette-observed-prefix'

const NO_PREFIX: readonly PaletteObservedOccurrence[] = []

type CommittedPalette = {
  key: string
  entries: readonly PaletteListEntry[]
  keys: readonly string[]
}

export function useWorktreeJumpPaletteObservedPrefix({
  generationKey,
  listRef,
  active = true
}: {
  generationKey: string
  listRef: RefObject<HTMLDivElement | null>
  active?: boolean
}) {
  const [observed, setObserved] = useState<{
    key: string
    prefix: readonly PaletteObservedOccurrence[]
    height: number
  }>({ key: generationKey, prefix: NO_PREFIX, height: 0 })
  const committed = useRef<CommittedPalette | null>(null)
  const keyboardGesture = useRef(false)
  const scrollGesture = useRef(false)
  useLayoutEffect(() => {
    keyboardGesture.current = false
    scrollGesture.current = false
  }, [generationKey])
  if (observed.key !== generationKey) {
    setObserved({ key: generationKey, prefix: NO_PREFIX, height: 0 })
  }
  const prefix = observed.key === generationKey ? observed.prefix : NO_PREFIX
  const height = observed.key === generationKey ? observed.height : 0
  const commitPresentation = useCallback(
    (entries: readonly PaletteListEntry[], keys: readonly string[]) => {
      committed.current = { key: generationKey, entries, keys }
    },
    [generationKey]
  )
  const capture = useCallback(
    (targetKey?: string) => {
      const snapshot = committed.current
      const list = listRef.current
      if (!active || !list || !snapshot || snapshot.key !== generationKey) {
        return
      }
      const viewport = list.getBoundingClientRect()
      let furthest = targetKey ? snapshot.keys.indexOf(targetKey) : -1
      for (const node of list.querySelectorAll<HTMLElement>('[data-palette-occurrence]')) {
        const rectangle = node.getBoundingClientRect()
        if (rectangle.bottom > viewport.top && rectangle.top < viewport.bottom) {
          furthest = Math.max(furthest, snapshot.keys.indexOf(node.dataset.paletteOccurrence ?? ''))
        }
      }
      if (furthest < 0) {
        return
      }
      const occurrences = describePaletteOccurrences(snapshot.entries, snapshot.keys)
      setObserved((previous) => {
        const observedKeys = new Set(
          previous.key === generationKey ? previous.prefix.map((entry) => entry.key) : []
        )
        const survivingEnd = occurrences.findLastIndex((entry) => observedKeys.has(entry.key))
        const next = occurrences.slice(0, Math.max(furthest, survivingEnd) + 1)
        if (
          previous.key === generationKey &&
          previous.prefix.length === next.length &&
          next.every((entry, index) => previous.prefix[index]?.key === entry.key)
        ) {
          return previous
        }
        return { key: generationKey, prefix: next, height: list.offsetHeight }
      })
    },
    [active, generationKey, listRef]
  )
  const handlePresentationKeyDown = useCallback(() => {
    capture()
    keyboardGesture.current = true
    queueMicrotask(() => {
      keyboardGesture.current = false
    })
  }, [capture])
  const handlePresentationSelectionChange = useCallback(
    (key: string) => {
      if (keyboardGesture.current) {
        capture(key)
      }
    },
    [capture]
  )
  const handlePresentationPointer = useCallback(
    (target: EventTarget | null) => {
      if (target instanceof Element) {
        capture(target.closest<HTMLElement>('[data-palette-occurrence]')?.dataset.paletteOccurrence)
      }
    },
    [capture]
  )
  const handlePresentationWheel = useCallback(() => {
    scrollGesture.current = true
    capture()
  }, [capture])
  const handlePresentationScroll = useCallback(() => {
    if (scrollGesture.current) {
      capture()
    }
  }, [capture])
  const handlePresentationScrollEnd = useCallback(() => {
    scrollGesture.current = false
  }, [])
  const resetPresentation = useCallback(() => {
    scrollGesture.current = false
    setObserved({ key: generationKey, prefix: NO_PREFIX, height: 0 })
  }, [generationKey])
  return {
    protectedOccurrences: prefix,
    presentationHeight: height,
    presentationInteracted: prefix.length > 0,
    commitPresentation,
    handlePresentationKeyDown,
    handlePresentationSelectionChange,
    handlePresentationPointer,
    handlePresentationWheel,
    handlePresentationScroll,
    handlePresentationScrollEnd,
    resetPresentation
  }
}

export function useCommitPalettePresentation(
  commit: (entries: readonly PaletteListEntry[], keys: readonly string[]) => void,
  entries: readonly PaletteListEntry[],
  keys: readonly string[]
): void {
  useLayoutEffect(() => commit(entries, keys), [commit, entries, keys])
}

export type WorktreeJumpPaletteObservedPrefix = ReturnType<
  typeof useWorktreeJumpPaletteObservedPrefix
>
