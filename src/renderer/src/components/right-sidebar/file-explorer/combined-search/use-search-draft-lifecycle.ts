import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import type { FileSearchWorktreeState } from '@/store/slices/editor/types/file-search-worktree-state'

type SearchDraft = { text: string; allowShort: boolean; token: number }

/** Bounded: only recently searched workspaces keep a draft. */
const MAX_DRAFTS = 64
let lastDraftToken = 0

function takeDraftToken(): number {
  lastDraftToken += 1
  return lastDraftToken
}

// Why: a Map, not the store, so recording every keystroke notifies no subscribers, and a remounting
// field (owner change, tab switch) reads the newest text instead of waiting on the old field's cleanup.
const draftsByWorktree = new Map<string, SearchDraft>()

function recordSearchDraft(worktreeId: string | null, draft: SearchDraft): void {
  if (!worktreeId) {
    return
  }
  draftsByWorktree.delete(worktreeId)
  if (!draft.text.trim()) {
    return
  }
  draftsByWorktree.set(worktreeId, draft)
  if (draftsByWorktree.size > MAX_DRAFTS) {
    const oldest = draftsByWorktree.keys().next().value
    if (oldest !== undefined) {
      draftsByWorktree.delete(oldest)
    }
  }
}

export type InitialSearchDraft = {
  text: string
  /** An explicit seed may search one character; typing never does. */
  allowShort: boolean
  /** A seed is pending, so the seed handler owns the first search. */
  seeded: boolean
}

/** What a worktree's field opens with: a pending query seed, else that worktree's live draft. */
export function getInitialSearchDraft(worktreeId: string | null): InitialSearchDraft {
  const stored = worktreeId
    ? useAppStore.getState().fileSearchStateByWorktree[worktreeId]
    : undefined
  const seeded = stored?.seedRequestId !== undefined
  if (seeded && stored?.seedKind === 'query' && stored.query.trim()) {
    return { text: stored.query, allowShort: true, seeded }
  }
  // Only the field that set `active` may restore: a purged, recreated or renamed workspace never
  // revives an older draft.
  const candidate = worktreeId ? draftsByWorktree.get(worktreeId) : undefined
  const draft = stored?.active && candidate?.token === stored.draftToken ? candidate : undefined
  return { text: draft?.text ?? '', allowShort: draft?.allowShort ?? false, seeded }
}

/**
 * Keeps the worktree's draft current on every commit, publishes whether results cover the tree,
 * and reruns the restored draft's text search once when the field mounts.
 */
export function useSearchDraftLifecycle({
  activeWorktreeId,
  query,
  allowShortQuery,
  initial,
  updateActiveSearchState,
  runTextSearch
}: {
  activeWorktreeId: string | null
  query: string
  allowShortQuery: boolean
  initial: InitialSearchDraft
  updateActiveSearchState: (updates: Partial<FileSearchWorktreeState>) => void
  runTextSearch: (query: string) => void
}): void {
  const hasQuery = query.trim().length > 0
  const [token] = useState(takeDraftToken)
  useLayoutEffect(() => {
    recordSearchDraft(activeWorktreeId, { text: query, allowShort: allowShortQuery, token })
  }, [activeWorktreeId, allowShortQuery, query, token])

  const latestRef = useRef({ updateActiveSearchState, runTextSearch })
  useLayoutEffect(() => {
    latestRef.current = { updateActiveSearchState, runTextSearch }
  })
  useEffect(() => {
    latestRef.current.updateActiveSearchState(
      hasQuery ? { active: true, draftToken: token } : { active: false }
    )
  }, [hasQuery, token])

  const initialRef = useRef(initial)
  const worktreeIdRef = useRef(activeWorktreeId)
  useEffect(() => {
    const { text, seeded } = initialRef.current
    const id = worktreeIdRef.current
    const stored = id ? useAppStore.getState().fileSearchStateByWorktree[id] : undefined
    const hasCurrentResults = stored?.query === text && stored.results !== null && !stored.loading
    if (text.trim() && !seeded && !hasCurrentResults) {
      latestRef.current.runTextSearch(text)
    }
  }, [])
}
