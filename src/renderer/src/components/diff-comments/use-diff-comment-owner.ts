import { useCallback, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAppStore } from '@/store'
import {
  createDiffCommentViewSelector,
  selectDiffCommentView,
  type DiffCommentOwner,
  type DiffCommentView
} from '@/store/diff-comment-owner'

/** The notes shown for a workspace and the copy they belong to, from one read. */
export function useDiffCommentView(worktreeId: string | null | undefined): DiffCommentView {
  const select = useMemo(() => createDiffCommentViewSelector(), [])
  return useAppStore((state) => select(state, worktreeId))
}

/** A composer target whose owner is captured when it opens, so a later submit saves to that copy. */
export function useOwnedDiffCommentTarget<T extends object>(worktreeId: string | null | undefined) {
  const [target, setTarget] = useState<T | null>(null)
  const capturedOwner = useRef<DiffCommentOwner | null>(null)
  // Stable per workspace: installed keyboard openers keep the first setter they were given.
  const setOwnedTarget = useCallback<Dispatch<SetStateAction<T | null>>>(
    (value) => {
      // Opening reads the owner the user acted on; position-only updates keep it.
      if (value && typeof value !== 'function') {
        capturedOwner.current = selectDiffCommentView(useAppStore.getState(), worktreeId).owner
      }
      setTarget(value)
    },
    [worktreeId]
  )
  return [target, setOwnedTarget, capturedOwner] as const
}
