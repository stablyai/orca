import { useCallback, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAppStore } from '@/store'
import {
  createDiffCommentViewSelector,
  createOwnedDiffCommentsSelector,
  selectDiffCommentView,
  type DiffCommentOwner,
  type DiffCommentView
} from '@/store/diff-comment-owner'
import type { DiffCommentSource } from '@/store/worktree-diff-comments-selector'
import type { DiffComment } from '../../../../shared/diff-comment-types'

/**
 * The notes a surface shows and the copy they belong to, from one read. A surface whose content
 * comes from a known server passes it as `source`; otherwise the selected copy is shown.
 */
export function useDiffCommentView(
  worktreeId: string | null | undefined,
  source?: DiffCommentSource
): DiffCommentView {
  const select = useMemo(() => createDiffCommentViewSelector(), [])
  const runtimeEnvironmentId = source?.runtimeEnvironmentId
  return useAppStore((state) => select(state, worktreeId, runtimeEnvironmentId))
}

/** The notes of a captured copy (an open confirmation), through the same cached read. */
export function useOwnedDiffComments(owner: DiffCommentOwner | null): DiffComment[] | undefined {
  const select = useMemo(() => createOwnedDiffCommentsSelector(), [])
  return useAppStore((state) => select(state, owner))
}

/** A composer target whose owner is captured when it opens, so a later submit saves to that copy. */
export function useOwnedDiffCommentTarget<T extends object>(
  worktreeId: string | null | undefined,
  source?: DiffCommentSource
) {
  const [target, setTarget] = useState<T | null>(null)
  const capturedOwner = useRef<DiffCommentOwner | null>(null)
  const runtimeEnvironmentId = source?.runtimeEnvironmentId
  // Stable per surface: installed keyboard openers keep the first setter they were given.
  const setOwnedTarget = useCallback<Dispatch<SetStateAction<T | null>>>(
    (value) => {
      // Opening reads the copy this surface shows; position-only updates keep it.
      if (value && typeof value !== 'function') {
        capturedOwner.current = selectDiffCommentView(useAppStore.getState(), worktreeId, {
          runtimeEnvironmentId
        }).owner
      }
      setTarget(value)
    },
    [runtimeEnvironmentId, worktreeId]
  )
  return [target, setOwnedTarget, capturedOwner] as const
}
