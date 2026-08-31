import React, { useEffect } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import { buildCombinedGitStatusSignature } from '../resolve-changes/combined-diff-git-status-signature'
import {
  getCombinedDiffFileTreeSectionKey,
  type CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'

// Why: git status and on-disk writes both revalidate loaded rows; one hook owns both watches so
// they cannot disagree about which sections are eligible.
export function useCombinedDiffSectionRevalidation({
  file,
  gitStatusEntries,
  requestSectionReload,
  sectionIndexByKeyRef,
  sections,
  shouldAutoReloadFromGitStatus,
  treeMode
}: {
  file: OpenFile
  gitStatusEntries: GitStatusEntry[]
  requestSectionReload: (index: number) => void
  sectionIndexByKeyRef: React.RefObject<ReadonlyMap<string, number>>
  sections: DiffSection[]
  shouldAutoReloadFromGitStatus: boolean
  treeMode: CombinedDiffFileTreeMode
}): string {
  const combinedGitStatusSignature = React.useMemo(() => {
    if (!shouldAutoReloadFromGitStatus) {
      return ''
    }
    return buildCombinedGitStatusSignature(sections, gitStatusEntries)
  }, [gitStatusEntries, sections, shouldAutoReloadFromGitStatus])
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
