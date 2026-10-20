import React, { useEffect, useRef } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import { buildCombinedGitStatusSignature } from '../resolve-changes/combined-diff-git-status-signature'
import {
  getCombinedDiffFileTreeSectionKey,
  type CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'
import type { CombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'

// Why: git status and on-disk writes both revalidate loaded rows; one hook owns both watches so
// they cannot disagree about which sections are eligible.
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
  // The entry set is structurally stable while individual section content/loading state changes.
  // Use it for the status signature so progressive loads do not rescan the section array.
  sectionEntries: readonly { path: string }[]
  shouldAutoReloadFromGitStatus: boolean
  treeMode: CombinedDiffFileTreeMode
}): string {
  const { loadedIndicesRef, loadingIndicesRef } = registry
  const combinedGitStatusSignature = React.useMemo(() => {
    if (!shouldAutoReloadFromGitStatus) {
      return ''
    }
    return buildCombinedGitStatusSignature(sectionEntries, gitStatusEntries)
  }, [gitStatusEntries, sectionEntries, shouldAutoReloadFromGitStatus])
  const prevCombinedGitStatusSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    if (!shouldAutoReloadFromGitStatus) {
      prevCombinedGitStatusSignatureRef.current = null
      return
    }
    if (prevCombinedGitStatusSignatureRef.current === null) {
      prevCombinedGitStatusSignatureRef.current = combinedGitStatusSignature
      return
    }
    if (prevCombinedGitStatusSignatureRef.current === combinedGitStatusSignature) {
      return
    }
    prevCombinedGitStatusSignatureRef.current = combinedGitStatusSignature
    for (const index of loadedIndicesRef.current) {
      requestSectionReload(index)
    }
  }, [
    combinedGitStatusSignature,
    loadedIndicesRef,
    requestSectionReload,
    shouldAutoReloadFromGitStatus
  ])

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
    // Why: a resync (the watch was down) names no paths, and snapshot-backed reviews skip
    // status-driven reloads, so re-read every loaded working-tree section of this workspace.
    // A storm overflow only refreshes git status, so it never re-reads every section.
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
      // Why: an in-flight read may have started before the missed write, so retry it too.
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

  return combinedGitStatusSignature
}
