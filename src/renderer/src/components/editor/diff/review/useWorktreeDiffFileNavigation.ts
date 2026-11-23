import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { joinPath } from '@/lib/path'
import { resolveSourceControlGroupOrder } from '../../../../../../shared/source-control/listing/source-control-section-order'
import {
  getAdjacentWorktreeDiffCandidate,
  getWorktreeDiffNavigationCandidates,
  type WorktreeDiffNavigationCandidate,
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

type WorktreeDiffFileArrival = {
  worktreeId: string
  path: string
  direction: WorktreeDiffNavigationDirection
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
  /** Direction to reveal in the hop target once its diff lands; null once the pane shows another file, disarming a stale reveal. */
  worktreeFileArrivalReveal: WorktreeDiffNavigationDirection | null
} {
  const [arrival, setArrival] = useState<WorktreeDiffFileArrival | null>(null)
  const activeWorktreeRoot = useAppStore((s) => {
    if (!activeFile) {
      return null
    }
    const hostId =
      activeFile.operationProvenance?.generation.route.executionHostId ??
      (activeFile.externalSshTargetId
        ? toSshExecutionHostId(activeFile.externalSshTargetId)
        : undefined)
    return getWorktreeOnHostFromState(s, activeFile.worktreeId, hostId)?.path ?? null
  })
  const activeEditorTargetGroupId = useAppStore((s) =>
    activeFile?.worktreeId
      ? (s.activeGroupIdByWorktree[activeFile.worktreeId] ??
        s.groupsByWorktree[activeFile.worktreeId]?.[0]?.id)
      : undefined
  )
  const sourceControlGroupOrderSetting = useAppStore((s) => s.settings?.sourceControlGroupOrder)
  const sourceControlViewModeSetting = useAppStore((s) => s.settings?.sourceControlViewMode)
  const sourceControlFilterQuery = useAppStore((s) => s.sourceControlFilterQuery)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openFile = useAppStore((s) => s.openFile)
  const openDiff = useAppStore((s) => s.openDiff)
  const groupOrder = useMemo(
    () => resolveSourceControlGroupOrder(sourceControlGroupOrderSetting),
    [sourceControlGroupOrderSetting]
  )
  const candidateOrder = useMemo(
    () => ({
      groupOrder,
      viewMode: sourceControlViewModeSetting === 'tree' ? ('tree' as const) : ('list' as const),
      filterQuery: sourceControlFilterQuery
    }),
    [groupOrder, sourceControlViewModeSetting, sourceControlFilterQuery]
  )
  const candidates = useMemo(
    () => getWorktreeDiffNavigationCandidates(gitStatusEntries, candidateOrder),
    [gitStatusEntries, candidateOrder]
  )
  const activeCandidate = activeFile
    ? (candidates.find((candidate) => candidate.path === activeFile.relativePath) ?? null)
    : null
  const isUnstagedDiffSurface = Boolean(
    activeFile?.mode === 'diff' && activeFile.diffSource === 'unstaged'
  )
  // Stay eligible after a refresh drops the current file's own entry; the resolver places the disappeared path.
  const isEligibleChangesSurface = Boolean(requestedChangesMode && activeFile?.worktreeId)
  const isWorktreeFileNavigationSurface = isUnstagedDiffSurface || isEligibleChangesSurface
  const canNavigateWorktreeFile = isWorktreeFileNavigationSurface && candidates.length > 1
  const arrivalReveal =
    arrival &&
    activeFile &&
    activeFile.worktreeId === arrival.worktreeId &&
    activeFile.relativePath === arrival.path
      ? arrival.direction
      : null

  const handleNavigateWorktreeFile = useCallback(
    (direction: WorktreeDiffNavigationDirection): boolean => {
      if (!activeFile || !canNavigateWorktreeFile) {
        return false
      }
      const candidate: WorktreeDiffNavigationCandidate | null = getAdjacentWorktreeDiffCandidate({
        entries: gitStatusEntries,
        order: candidateOrder,
        currentPath: activeFile.relativePath,
        currentArea: activeCandidate?.area ?? 'unstaged',
        direction
      })
      const worktreeRoot =
        activeWorktreeRoot ?? inferWorktreeRoot(activeFile.filePath, activeFile.relativePath)
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
      } else {
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
      }
      setArrival({ worktreeId: activeFile.worktreeId, path: candidate.path, direction })
      return true
    },
    [
      activeCandidate,
      activeEditorTargetGroupId,
      activeFile,
      activeWorktreeRoot,
      candidateOrder,
      canNavigateWorktreeFile,
      gitStatusEntries,
      openDiff,
      openFile,
      setEditorViewMode
    ]
  )

  return {
    canNavigateWorktreeFile,
    handleNavigateWorktreeFile,
    isWorktreeFileNavigationSurface,
    worktreeFileArrivalReveal: arrivalReveal
  }
}
