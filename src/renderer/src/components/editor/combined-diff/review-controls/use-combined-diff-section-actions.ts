import { editorViewPlacement } from '@/store/slices/editor/tabs/editor-view-placement'
import { useCallback } from 'react'
import { useCombinedDiffSectionSave } from './use-combined-diff-section-save'
import type React from 'react'
import { useAppStore } from '@/store'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { joinPath } from '@/lib/path'
import { openFilePreviewToSide } from '@/lib/browser/documents/file-preview'
import { openMarkdownPreviewToSide } from '@/lib/files/open/markdown-preview-to-side'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import { diffSectionPreviewTarget } from '../../diff/sections/diff-section-preview'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import type { DiffSectionItemProps } from '../../diff/sections/diff-section-item-props'

export type CombinedDiffSectionActions = {
  handleSectionSaveRef: DiffSectionItemProps['handleSectionSaveRef']
  modifiedEditorsRef: DiffSectionItemProps['modifiedEditorsRef']
  openAlternateDiff: () => void
  openSection: (index: number) => void
  openSectionPreview: (section: DiffSection) => void
}

export function useCombinedDiffSectionActions({
  activeGroupId,
  viewStateScopeId,
  branchSummary,
  branchCompare,
  canOpenWorkspaceFileBrowserForPath,
  commitCompare,
  file,
  isAllMode,
  isBranchMode,
  isCommitMode,
  sectionsRef,
  setSectionHeights,
  setSections
}: {
  activeGroupId: string | undefined
  viewStateScopeId?: string
  branchSummary?: AppState['gitBranchCompareSummaryByWorktree'][string]
  branchCompare: NonNullable<OpenFile['branchCompare']> | null
  canOpenWorkspaceFileBrowserForPath: (path: string) => boolean
  commitCompare: NonNullable<OpenFile['commitCompare']> | null
  file: OpenFile
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  sections: DiffSection[]
  sectionsRef: React.RefObject<DiffSection[]>
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}): CombinedDiffSectionActions {
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)
  const openFile = useAppStore((s) => s.openFile)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)
  const openCommitDiff = useAppStore((s) => s.openCommitDiff)
  const { handleSectionSaveRef, modifiedEditorsRef } = useCombinedDiffSectionSave({
    file,
    sectionsRef,
    setSectionHeights,
    setSections
  })

  const openSection = useCallback(
    (index: number) => {
      const section = sectionsRef.current[index]
      if (!section) {
        return
      }

      const placement = editorViewPlacement(useAppStore.getState(), file, viewStateScopeId)
      const language = detectLanguage(section.path)
      const entry: GitBranchChangeEntry = {
        path: section.path,
        status: section.status as GitBranchChangeEntry['status'],
        oldPath: section.oldPath,
        added: section.added,
        removed: section.removed
      }

      const isBranchEntry = section.area === undefined

      if ((isBranchMode || (isAllMode && isBranchEntry)) && branchCompare) {
        openBranchDiff(file.worktreeId, file.filePath, entry, branchCompare, language, {
          ...placement,
          runtimeEnvironmentId: file.runtimeEnvironmentId
        })
        return
      }

      if (isCommitMode && commitCompare) {
        openCommitDiff(file.worktreeId, file.filePath, entry, commitCompare, language, {
          ...placement,
          runtimeEnvironmentId: file.runtimeEnvironmentId
        })
        return
      }

      openFile(
        {
          filePath: joinPath(file.filePath, section.path),
          relativePath: section.path,
          worktreeId: file.worktreeId,
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          language,
          mode: 'edit'
        },
        placement
      )
    },
    [
      branchCompare,
      commitCompare,
      file,
      viewStateScopeId,
      isAllMode,
      isBranchMode,
      isCommitMode,
      openBranchDiff,
      openCommitDiff,
      openFile,
      sectionsRef
    ]
  )

  // Preview the on-disk working file beside this combined view: HTML as a page, Markdown rendered.
  const openSectionPreview = useCallback(
    (section: DiffSection) => {
      const filePath = joinPath(file.filePath, section.path)
      const target = diffSectionPreviewTarget({
        path: section.path,
        status: section.status,
        isCommitSurface: isCommitMode,
        canOpenWorkspaceFileBrowser: canOpenWorkspaceFileBrowserForPath(filePath)
      })
      if (!target) {
        return
      }
      // Use this tab’s split group; the workspace active group may belong to another pane.
      const state = useAppStore.getState()
      const placement = editorViewPlacement(state, file, viewStateScopeId)
      const sourceGroupId = placement.targetGroupId ?? activeGroupId ?? null
      if (target === 'markdown-preview') {
        openMarkdownPreviewToSide({
          filePath,
          relativePath: section.path,
          worktreeId: file.worktreeId,
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          placementWorkspaceId: placement.placementWorkspaceId,
          sourceGroupId
        })
        return
      }
      openFilePreviewToSide({
        language: detectLanguage(section.path),
        filePath,
        worktreeId: file.worktreeId,
        placementWorkspaceId: placement.placementWorkspaceId,
        sourceGroupId
      })
    },
    [activeGroupId, viewStateScopeId, file, canOpenWorkspaceFileBrowserForPath, isCommitMode]
  )

  const openAlternateDiff = useCallback(() => {
    if (!file.combinedAlternate) {
      return
    }
    const placement = editorViewPlacement(useAppStore.getState(), file, viewStateScopeId)
    const options = { ...placement, runtimeEnvironmentId: file.runtimeEnvironmentId }
    if (file.combinedAlternate.source === 'combined-all') {
      openAllDiffs(file.worktreeId, file.filePath, undefined, undefined, undefined, options)
    } else if (branchSummary?.status === 'ready') {
      openBranchAllDiffs(
        file.worktreeId,
        file.filePath,
        branchSummary,
        { source: 'combined-all' },
        options
      )
    }
  }, [branchSummary, file, openAllDiffs, openBranchAllDiffs, viewStateScopeId])

  return {
    handleSectionSaveRef,
    modifiedEditorsRef,
    openSection,
    openSectionPreview,
    openAlternateDiff
  }
}
