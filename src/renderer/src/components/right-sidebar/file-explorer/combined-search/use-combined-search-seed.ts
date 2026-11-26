import type React from 'react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'

/** Applies search-selection and Find in Folder seeds to the live draft, then focuses and selects the field. */
export function useCombinedSearchSeed({
  activeWorktreeId,
  seedRequestId,
  focusRequestId,
  query,
  lastCommittedQueryRef,
  inputRef,
  applySeededQuery
}: {
  activeWorktreeId: string | null
  seedRequestId: number | undefined
  focusRequestId: number | undefined
  query: string
  lastCommittedQueryRef: React.RefObject<string | null>
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Runs the text search for the seeded or live query at any length. */
  applySeededQuery: (query: string) => void
}): void {
  const liveQueryRef = useRef(query)
  liveQueryRef.current = query
  const selectionFrameRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current)
      }
    },
    []
  )

  // Seeds apply by presence and are consumed, so a reused id after consumption still applies.
  useEffect(() => {
    if (!activeWorktreeId || seedRequestId === undefined) {
      return
    }
    const state = useAppStore.getState()
    const stored = state.fileSearchStateByWorktree[activeWorktreeId]?.query ?? ''
    const live = liveQueryRef.current
    // A stored query this panel did not commit is a query seed; otherwise only filters changed.
    const nextQuery = stored !== lastCommittedQueryRef.current && stored.trim() ? stored : live
    if (nextQuery.trim()) {
      applySeededQuery(nextQuery)
    }
    if (selectionFrameRef.current !== null) {
      cancelAnimationFrame(selectionFrameRef.current)
    }
    selectionFrameRef.current = requestAnimationFrame(() => {
      selectionFrameRef.current = null
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    state.consumeFileSearchSeedRequest(activeWorktreeId, seedRequestId)
  }, [activeWorktreeId, applySeededQuery, inputRef, lastCommittedQueryRef, seedRequestId])

  useEffect(() => {
    if (activeWorktreeId && focusRequestId !== undefined) {
      inputRef.current?.focus()
    }
  }, [activeWorktreeId, focusRequestId, inputRef])
}
