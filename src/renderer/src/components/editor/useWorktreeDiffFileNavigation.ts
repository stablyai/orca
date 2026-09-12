import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import type { OpenFile } from '@/store/slices/editor'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { resolveSourceControlGroupOrder } from '../right-sidebar/source-control/listing/section-order'
import {
  getAdjacentWorktreeDiffCandidate,
  getWorktreeDiffNavigationCandidates,
  type WorktreeDiffNavigationDirection
} from './worktree-diff-file-navigation'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function inferWorktreeRoot(filePath: string, relativePath: string): string | null {
  const normalizedRelativePath = relativePath.replace(/[\\/]+/g, '/')
  if (!normalizedRelativePath) {
    return null
  }
  const relativePathPattern = normalizedRelativePath.split('/').map(escapeRegex).join('[\\\\/]')
  const match = new RegExp(`[\\\\/]${relativePathPattern}$`).exec(filePath)
  return match?.index === undefined ? null : filePath.slice(0, match.index)
}

export function useWorktreeDiffFileNavigation({
  activeFile,
  gitStatusEntries,
  requestedChangesMode
}: {
  activeFile: OpenFile | null
  gitStatusEntries: readonly GitStatusEntry[] | undefined
  requestedChangesMode: boolean
}): {
  canNavigateWorktreeFile: boolean
  handleNavigateWorktreeFile: (direction: WorktreeDiffNavigationDirection) => boolean
  isWorktreeFileNavigationSurface: boolean
} {
  const activeWorktreeId = activeFile?.worktreeId
  const activeWorktreeRoot = useAppStore((s) =>
    activeWorktreeId ? (getWorktreeMapFromState(s).get(activeWorktreeId)?.path ?? null) : null
  )
  const activeEditorTargetGroupId = useAppStore((s) =>
    activeWorktreeId
      ? (s.activeGroupIdByWorktree[activeWorktreeId] ?? s.groupsByWorktree[activeWorktreeId]?.[0]?.id)
      : undefined
  )
  const sourceControlGroupOrderSetting = useAppStore((s) => s.settings?.sourceControlGroupOrder)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openFile = useAppStore((s) => s.openFile)
  const openDiff = useAppStore((s) => s.openDiff)
  const sourceControlGroupOrder = useMemo(
    () => resolveSourceControlGroupOrder(sourceControlGroupOrderSetting),
    [sourceControlGroupOrderSetting]
  )
  const candidates = useMemo(
    () => getWorktreeDiffNavigationCandidates(gitStatusEntries, sourceControlGroupOrder),
    [gitStatusEntries, sourceControlGroupOrder]
  )
  const activeCandidate = activeFile
    ? (candidates.find((candidate) => candidate.path === activeFile.relativePath) ?? null)
    : null
  const isUnstagedDiffSurface = Boolean(
    activeFile?.mode === 'diff' && activeFile.diffSource === 'unstaged'
  )
  const isEligibleChangesSurface = Boolean(requestedChangesMode && activeCandidate)
  const isWorktreeFileNavigationSurface = isUnstagedDiffSurface || isEligibleChangesSurface
  const canNavigateWorktreeFile = isWorktreeFileNavigationSurface && candidates.length > 1
  const handleNavigateWorktreeFile = useCallback(
    (direction: WorktreeDiffNavigationDirection): boolean => {
      if (!activeFile || !canNavigateWorktreeFile) {
        return false
      }
      const candidate = getAdjacentWorktreeDiffCandidate({
        candidates,
        currentPath: activeFile.relativePath,
        currentArea: activeCandidate?.area ?? 'unstaged',
        direction
      })
      const worktreeRoot = activeWorktreeRoot ?? inferWorktreeRoot(activeFile.filePath, activeFile.relativePath)
      if (!candidate || !worktreeRoot) {
        return false
      }
      const filePath = joinPath(worktreeRoot, candidate.path)
      const language = detectLanguage(candidate.path)
      if (candidate.status === 'deleted') {
        openDiff(activeFile.worktreeId, filePath, candidate.path, language, false, {
          targetGroupId: activeEditorTargetGroupId,
          runtimeEnvironmentId: activeFile.runtimeEnvironmentId
        })
        return true
      }
      const openedFileId = openFile(
        {
          filePath,
          relativePath: candidate.path,
          worktreeId: activeFile.worktreeId,
          runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
          language,
          mode: 'edit'
        },
        { targetGroupId: activeEditorTargetGroupId }
      )
      setEditorViewMode(openedFileId, 'changes')
      return true
    },
    [
      activeCandidate,
      activeEditorTargetGroupId,
      activeFile,
      activeWorktreeRoot,
      canNavigateWorktreeFile,
      candidates,
      openDiff,
      openFile,
      setEditorViewMode
    ]
  )

  return { canNavigateWorktreeFile, handleNavigateWorktreeFile, isWorktreeFileNavigationSurface }
}
