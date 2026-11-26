import type React from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'

/** Applies search-selection and Find in Folder seeds to the live draft, then focuses and selects the field. */
export function useCombinedSearchSeed({
  activeWorktreeId,
  seedRequestId,
  focusRequestId,
  query,
  inputRef,
  applySeededQuery,
  rerunDraft
}: {
  activeWorktreeId: string | null
  seedRequestId: number | undefined
  focusRequestId: number | undefined
  query: string
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Replaces the draft with a seeded query and searches it at any length. */
  applySeededQuery: (query: string) => void
  /** Reruns the live draft after a filters-only seed (Find in Folder). */
  rerunDraft: (query: string) => void
}): void {
  const liveQueryRef = useRef(query)
  useLayoutEffect(() => {
    liveQueryRef.current = query
  })
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
    const seeded = state.fileSearchStateByWorktree[activeWorktreeId]
    if (seeded?.seedKind === 'query' && seeded.query.trim()) {
      applySeededQuery(seeded.query)
    } else if (liveQueryRef.current.trim()) {
      rerunDraft(liveQueryRef.current)
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
  }, [activeWorktreeId, applySeededQuery, inputRef, rerunDraft, seedRequestId])

  // Consumed once so a remount or workspace switch never replays an old focus request.
  useEffect(() => {
    if (activeWorktreeId && focusRequestId !== undefined) {
      inputRef.current?.focus()
      useAppStore.getState().consumeFileSearchFocusRequest(activeWorktreeId, focusRequestId)
    }
  }, [activeWorktreeId, focusRequestId, inputRef])
}
