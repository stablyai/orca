import React, { useEffect, useRef } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import { buildCombinedGitStatusSnapshot } from '../resolve-changes/combined-diff-git-status-signature'
import {
  getCombinedDiffFileTreeSectionKey,
  type CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'
import type { CombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'

// Share status and disk-write watches so both apply identical eligibility rules.
export function useCombinedDiffSectionRevalidation({
  file,
  gitStatusEntries,
  registry,
  requestSectionReload,
  sectionIndexByKeyRef,
  sectionEntries,
  shouldAutoReloadFromGitStatus,
  treeMode
}: {
  file: OpenFile
  gitStatusEntries: GitStatusEntry[]
  registry: Pick<CombinedDiffSectionLoadRegistry, 'loadedIndicesRef' | 'loadingIndicesRef'>
  requestSectionReload: (index: number) => void
  sectionIndexByKeyRef: React.RefObject<ReadonlyMap<string, number>>
  // Use stable entry paths for status signatures so progressive content loads cannot trigger full rescans.
  sectionEntries: readonly { path: string }[]
  shouldAutoReloadFromGitStatus: boolean
  treeMode: CombinedDiffFileTreeMode
}): string {
  const { loadedIndicesRef, loadingIndicesRef } = registry
  const statusSnapshot = React.useMemo(() => {
    if (!shouldAutoReloadFromGitStatus) {
      return null
    }
    return buildCombinedGitStatusSnapshot(sectionEntries, gitStatusEntries)
  }, [gitStatusEntries, sectionEntries, shouldAutoReloadFromGitStatus])
  const previousStatusSnapshotRef = useRef<ReturnType<
    typeof buildCombinedGitStatusSnapshot
  > | null>(null)

  useEffect(() => {
    if (statusSnapshot === null) {
      previousStatusSnapshotRef.current = null
      return
    }
    const previousStatusSnapshot = previousStatusSnapshotRef.current
    previousStatusSnapshotRef.current = statusSnapshot
    if (
      previousStatusSnapshot === null ||
      previousStatusSnapshot.signature === statusSnapshot.signature
    ) {
      return
    }
    for (const index of new Set([...loadedIndicesRef.current, ...loadingIndicesRef.current])) {
      const path = sectionEntries[index]?.path
      if (
        path !== undefined &&
        previousStatusSnapshot.pathSignatures.get(path) !== statusSnapshot.pathSignatures.get(path)
      ) {
        requestSectionReload(index)
      }
    }
  }, [loadedIndicesRef, loadingIndicesRef, requestSectionReload, sectionEntries, statusSnapshot])

  useEffect(() => {
    if (treeMode !== 'all' && treeMode !== 'uncommitted') {
      return
    }
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
      if (!detail || detail.worktreeId !== file.worktreeId) {
        return
      }
      const hasRuntimeOwnerFilter = Object.hasOwn(detail, 'runtimeEnvironmentId')
      const targetRuntimeOwner = detail.runtimeEnvironmentId?.trim() || null
      const fileRuntimeOwner = file.runtimeEnvironmentId?.trim() || null
      if (hasRuntimeOwnerFilter && targetRuntimeOwner !== fileRuntimeOwner) {
        return
      }
      for (const area of ['unstaged', 'staged', 'untracked'] as const) {
        const key = getCombinedDiffFileTreeSectionKey('uncommitted', {
          path: detail.relativePath,
          status: 'modified',
          area
        })
        const index = sectionIndexByKeyRef.current.get(key)
        if (index !== undefined) {
          requestSectionReload(index)
        }
      }
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
    return () =>
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
  }, [
    file.runtimeEnvironmentId,
    file.worktreeId,
    requestSectionReload,
    sectionIndexByKeyRef,
    treeMode
  ])

  useEffect(() => {
    if (treeMode !== 'all' && treeMode !== 'uncommitted') {
      return
    }
    // Watch-gap resync has no paths and must refresh loaded snapshot-backed sections too; storm overflow only refreshes status.
    const handler = (event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]): void => {
      const { payload, runtimeEnvironmentId } = event.detail
      if (
        (runtimeEnvironmentId?.trim() || null) !== (file.runtimeEnvironmentId?.trim() || null) ||
        normalizeRuntimePathForComparison(payload.worktreePath) !==
          normalizeRuntimePathForComparison(file.filePath) ||
        payload.resync !== true
      ) {
        return
      }
      // Retry in-flight reads too; they may have started before the missed write.
      for (const index of new Set([...loadedIndicesRef.current, ...loadingIndicesRef.current])) {
        requestSectionReload(index)
      }
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handler)
    return () => window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handler)
  }, [
    file.filePath,
    file.runtimeEnvironmentId,
    loadedIndicesRef,
    loadingIndicesRef,
    requestSectionReload,
    treeMode
  ])

  return statusSnapshot?.signature ?? ''
}
