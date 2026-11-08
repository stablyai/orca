import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAppStore } from '@/store'
import {
  createDiffCommentViewSelector,
  createOwnedDiffCommentsSelector,
  selectDiffCommentView,
  sourceParts,
  type DiffCommentOwner,
  type DiffCommentView
} from '@/store/slices/diff-comments/diff-comment-owner'
import type { WorkspaceCopySource } from '@/lib/workspace-copy-owner'
import type { DiffComment } from '../../../../shared/diff-comment-types'

/**
 * The notes a surface shows and the copy they belong to, from one read. A retained surface passes
 * its own resource (its tab); only selection-bound views pass `'selection'`.
 */
export function useDiffCommentView(
  worktreeId: string | null | undefined,
  source: WorkspaceCopySource
): DiffCommentView {
  const select = useMemo(() => createDiffCommentViewSelector(), [])
  const [selection, runtimeEnvironmentId, externalSshTargetId, operationProvenance] =
    sourceParts(source)
  return useAppStateValue((state) =>
    select(
      state,
      worktreeId,
      selection,
      runtimeEnvironmentId,
      externalSshTargetId,
      operationProvenance
    )
  )
}

/** The notes of a captured copy (an open confirmation), through the same cached read. */
export function useOwnedDiffComments(owner: DiffCommentOwner | null): DiffComment[] | undefined {
  const select = useMemo(() => createOwnedDiffCommentsSelector(), [])
  return useAppStateValue((state) => select(state, owner))
}

/** A composer target whose owner is captured when it opens, so a later submit saves to that copy. */
export function useOwnedDiffCommentTarget<T extends object>(
  worktreeId: string | null | undefined,
  source: WorkspaceCopySource
) {
  const [target, setTarget] = useState<T | null>(null)
  const capturedOwner = useRef<DiffCommentOwner | null>(null)
  // Installed keyboard openers keep the first setter they were given, so it reads the current surface.
  const current = useRef({ worktreeId, source })
  useLayoutEffect(() => {
    current.current = { worktreeId, source }
  })
  const setOwnedTarget = useCallback<Dispatch<SetStateAction<T | null>>>((value) => {
    // Opening reads the copy this surface shows now; position-only updates keep it.
    if (value && typeof value !== 'function') {
      capturedOwner.current = selectDiffCommentView(
        useAppStore.getState(),
        current.current.worktreeId,
        current.current.source
      ).owner
    }
    setTarget(value)
  }, [])
  return [target, setOwnedTarget, capturedOwner] as const
}
