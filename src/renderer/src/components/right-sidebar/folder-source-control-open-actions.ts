import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitStatusEntry
} from '../../../../shared/types'

export function useFolderSourceControlOpenActions({
  diffWorktreeId,
  targetPath,
  branchCompare,
  showVisibleEditorTab,
  statusEntries
}: {
  diffWorktreeId: string
  targetPath: string
  branchCompare: GitBranchCompareResult | null
  showVisibleEditorTab: (fileId: string, contentType: 'editor' | 'diff', label: string) => void
  statusEntries: readonly GitStatusEntry[]
}): {
  openEntry: (entry: GitStatusEntry) => void
  openBranchEntry: (entry: GitBranchChangeEntry) => void
  viewAllArea: (area: 'staged' | 'unstaged' | 'untracked') => void
} {
  const openFile = useAppStore((state) => state.openFile)
  const openDiff = useAppStore((state) => state.openDiff)
  const openBranchDiff = useAppStore((state) => state.openBranchDiff)
  const openAllDiffs = useAppStore((state) => state.openAllDiffs)
  const openConflictFile = useAppStore((state) => state.openConflictFile)
  const setEditorViewMode = useAppStore((state) => state.setEditorViewMode)

  const openEntry = useCallback(
    (entry: GitStatusEntry) => {
      const filePath = joinPath(targetPath, entry.path)
      const language = detectLanguage(entry.path)
      if (entry.conflictKind && entry.conflictStatus) {
        openConflictFile(diffWorktreeId, targetPath, entry, language)
        const conflictFile = useAppStore
          .getState()
          .openFiles.find((file) => file.filePath === filePath && file.mode === 'edit')
        if (conflictFile) {
          showVisibleEditorTab(conflictFile.id, 'editor', conflictFile.relativePath)
        }
        return
      }
      if (language === 'markdown' && entry.area === 'unstaged') {
        const fileId = openFile({
          filePath,
          relativePath: entry.path,
          worktreeId: diffWorktreeId,
          language,
          mode: 'edit'
        })
        showVisibleEditorTab(fileId, 'editor', entry.path)
        setEditorViewMode(filePath, 'changes')
        return
      }
      openDiff(diffWorktreeId, filePath, entry.path, language, entry.area === 'staged')
      const diffFile = useAppStore
        .getState()
        .openFiles.find(
          (file) =>
            file.filePath === filePath && file.relativePath === entry.path && file.mode === 'diff'
        )
      if (diffFile) {
        showVisibleEditorTab(diffFile.id, 'diff', diffFile.relativePath)
      }
    },
    [
      diffWorktreeId,
      openConflictFile,
      openDiff,
      openFile,
      setEditorViewMode,
      showVisibleEditorTab,
      targetPath
    ]
  )

  const openBranchEntry = useCallback(
    (entry: GitBranchChangeEntry) => {
      if (branchCompare) {
        openBranchDiff(
          diffWorktreeId,
          targetPath,
          entry,
          branchCompare.summary,
          detectLanguage(entry.path)
        )
      } else {
        openDiff(
          diffWorktreeId,
          joinPath(targetPath, entry.path),
          entry.path,
          detectLanguage(entry.path),
          false
        )
      }
      const filePath = joinPath(targetPath, entry.path)
      const diffFile = useAppStore
        .getState()
        .openFiles.find(
          (file) =>
            file.filePath === filePath && file.relativePath === entry.path && file.mode === 'diff'
        )
      if (diffFile) {
        showVisibleEditorTab(diffFile.id, 'diff', diffFile.relativePath)
      }
    },
    [branchCompare, diffWorktreeId, openBranchDiff, openDiff, showVisibleEditorTab, targetPath]
  )

  const viewAllArea = useCallback(
    (area: 'staged' | 'unstaged' | 'untracked') => {
      const entries = statusEntries.filter((entry) => entry.area === area)
      openAllDiffs(diffWorktreeId, targetPath, undefined, area, entries)
      showVisibleEditorTab(`${diffWorktreeId}::all-diffs::uncommitted::${area}`, 'diff', area)
    },
    [diffWorktreeId, openAllDiffs, showVisibleEditorTab, statusEntries, targetPath]
  )

  return { openEntry, openBranchEntry, viewAllArea }
}
