import { useCallback, useEffect, useMemo } from 'react'
import { readAppState } from '@/store'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { captureEditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import {
  type DiffReviewEntry,
  diffReviewKey,
  diffReviewScope,
  entryReviewSource,
  getReviewedDiffs,
  reviewEntrySignature,
  setDiffReviewed,
  useReviewedDiffs
} from '@/lib/editor/diff-reviewed-files'
import {
  statRuntimePath,
  isMissingRuntimePathError
} from '@/runtime/files/metadata/runtime-file-metadata-client'
import { joinPath } from '@/lib/path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../../../shared/cross-platform-path'
import {
  getKnownExecutionHostIdForWorktree,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from '@/lib/workspace/ownership/worktree-runtime-owner'
import { subscribeRuntimeFileChanges } from '@/runtime/files/watching/runtime-file-watch-client'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import {
  sourceControlScopeRuntimeEnvironmentId,
  useSourceControlScope,
  useSourceControlState
} from '../panel/worktree-scope'

export function useSourceControlReview(worktreeId: string | null, worktreePath: string | null) {
  const scope = useSourceControlScope()
  const executionHostId = useSourceControlState(
    (s) => scope?.executionHostId ?? getKnownExecutionHostIdForWorktree(s, worktreeId)
  )
  const runtimeEnvironmentId = useSourceControlState((s) =>
    scope
      ? sourceControlScopeRuntimeEnvironmentId(scope)
      : runtimeEnvironmentIdOrLocalUnlessTwin(s, worktreeId)
  )
  const branchCompare = useSourceControlState((s) =>
    worktreeId ? s.gitBranchCompareSummaryByWorktree[worktreeId] : undefined
  )
  const records = useReviewedDiffs()
  const owner = useMemo(() => {
    if (!worktreeId || !worktreePath || !executionHostId) {
      return null
    }
    try {
      const state = readAppState()
      const operationProvenance = captureEditorFileOperationProvenance(
        state,
        worktreeId,
        runtimeEnvironmentId,
        runtimeEnvironmentId !== undefined,
        executionHostId
      )
      return getEditorFileReadContext(state, { worktreeId, operationProvenance }, worktreePath)
    } catch {
      return null
    }
  }, [worktreeId, worktreePath, runtimeEnvironmentId, executionHostId])
  const keyFor = useCallback(
    (entry: DiffReviewEntry, source: 'unstaged' | 'staged' | 'branch') =>
      owner
        ? diffReviewKey(owner, entry.path, diffReviewScope({ diffSource: source, branchCompare }))
        : null,
    [owner, branchCompare]
  )
  const isViewed = useCallback(
    (entry: DiffReviewEntry, source: 'unstaged' | 'staged' | 'branch') => {
      const key = keyFor(entry, source)
      return key !== null && records.get(key)?.entrySignature === reviewEntrySignature(entry)
    },
    [keyFor, records]
  )
  return useMemo(() => ({ owner, records, keyFor, isViewed }), [owner, records, keyFor, isViewed])
}

export function useRevalidateSourceControlReviews(
  review: Pick<ReturnType<typeof useSourceControlReview>, 'owner' | 'keyFor'>,
  entries: readonly GitStatusEntry[],
  branchEntries: readonly GitBranchChangeEntry[]
): void {
  const { owner, keyFor } = review
  useEffect(() => {
    let cancelled = false
    if (!owner) {
      return
    }
    const check = async (entry: DiffReviewEntry, source: 'unstaged' | 'staged' | 'branch') => {
      const key = keyFor(entry, source)
      const record = key ? getReviewedDiffs().get(key) : undefined
      if (!key || !record) {
        return
      }
      if (record.entrySignature !== reviewEntrySignature(entry)) {
        setDiffReviewed(key, null)
        return
      }
      if (record.modifiedTime === null) {
        return
      }
      try {
        const stat = await statRuntimePath(owner, joinPath(owner.worktreePath!, entry.path))
        if (
          !cancelled &&
          getReviewedDiffs().get(key) === record &&
          stat.mtime !== record.modifiedTime
        ) {
          setDiffReviewed(key, null)
        }
      } catch (error) {
        if (
          !cancelled &&
          getReviewedDiffs().get(key) === record &&
          isMissingRuntimePathError(error)
        ) {
          setDiffReviewed(key, null)
        }
      }
    }
    for (const entry of entries) {
      void check(entry, entryReviewSource(entry))
    }
    for (const entry of branchEntries) {
      void check(entry, 'branch')
    }
    let unsubscribe: (() => void) | undefined
    void subscribeRuntimeFileChanges(owner, (payload) => {
      if (
        normalizeRuntimePathForComparison(payload.worktreePath) !==
          normalizeRuntimePathForComparison(owner.worktreePath!) ||
        (owner.target.kind !== 'environment' &&
          (payload.connectionId ?? null) !== (owner.connectionId ?? null))
      ) {
        return
      }
      const invalidate = (entry: DiffReviewEntry, source: 'unstaged' | 'staged' | 'branch') => {
        const key = keyFor(entry, source)
        if (!key || !getReviewedDiffs().has(key)) {
          return
        }
        const absolutePath = joinPath(owner.worktreePath!, entry.path)
        const changed = payload.events.some((event) =>
          [event.absolutePath, event.oldAbsolutePath].some(
            (eventPath) =>
              eventPath &&
              (event.isDirectory
                ? isPathInsideOrEqual(eventPath, absolutePath)
                : normalizeRuntimePathForComparison(eventPath) ===
                  normalizeRuntimePathForComparison(absolutePath))
          )
        )
        if (changed) {
          const key = keyFor(entry, source)
          if (key) {
            setDiffReviewed(key, null)
          }
        }
        if (payload.resync || payload.events.some((event) => event.kind === 'overflow')) {
          void check(entry, source)
        }
      }
      for (const entry of entries) {
        invalidate(entry, entryReviewSource(entry))
      }
      for (const entry of branchEntries) {
        invalidate(entry, 'branch')
      }
    })
      .then((stop) => {
        if (cancelled) {
          stop()
        } else {
          unsubscribe = stop
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [owner, keyFor, entries, branchEntries])
}
