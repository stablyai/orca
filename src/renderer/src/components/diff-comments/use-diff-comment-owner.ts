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
import type { WorkspaceCopySource } from '@/lib/workspace/ownership/workspace-copy-owner'
import type { DiffComment } from '../../../../shared/file-review/diff-comment-types'
import {
  readRetainedDiffCommentTarget,
  writeRetainedDiffCommentTarget
} from './retained-diff-comment-drafts'

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

/**
 * A composer target whose owner is captured when it opens, so a later submit saves to that copy.
 * With `retainKey` the target outlives this component (virtualized rows, hidden tabs).
 */
export function useOwnedDiffCommentTarget<T extends object>(
  worktreeId: string | null | undefined,
  source: WorkspaceCopySource,
  retainKey?: string
) {
  const [retained] = useState(() =>
    retainKey ? readRetainedDiffCommentTarget(retainKey) : undefined
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a retain key is written only by the surface that reads it, with the same target type.
  const [target, setTarget] = useState<T | null>((retained?.target ?? null) as T | null)
  const capturedOwner = useRef<DiffCommentOwner | null>(retained?.owner ?? null)
  // Installed keyboard openers keep the first setter they were given, so it reads the current surface.
  const current = useRef({ worktreeId, source, retainKey })
  useLayoutEffect(() => {
    current.current = { worktreeId, source, retainKey }
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
    setTarget((previous) => {
      const next = typeof value === 'function' ? value(previous) : value
      const { retainKey: key } = current.current
      if (key) {
        writeRetainedDiffCommentTarget(key, { target: next, owner: capturedOwner.current })
      }
      return next
    })
  }, [])
  return [target, setOwnedTarget, capturedOwner] as const
}
