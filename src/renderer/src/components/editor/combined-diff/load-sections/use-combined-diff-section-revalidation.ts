import React, { useEffect, useRef } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
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
  registry: CombinedDiffSectionLoadRegistry
  requestSectionReload: (index: number) => void
  sectionIndexByKeyRef: React.RefObject<ReadonlyMap<string, number>>
  // The entry set is structurally stable while individual section content/loading state changes.
  // Use it for the status signature so progressive loads do not rescan the section array.
  sectionEntries: readonly { path: string }[]
  shouldAutoReloadFromGitStatus: boolean
  treeMode: CombinedDiffFileTreeMode
}): string {
  const { loadedIndicesRef } = registry
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

  return combinedGitStatusSignature
}
