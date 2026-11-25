import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import {
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { joinPath } from '@/lib/path'
import {
  buildActiveOpenFileSignature,
  buildActiveOpenRowKeys
} from '../../../right-sidebar/source-control/listing/active-open-file-keys'
import { openUncommittedEntry } from '../../../right-sidebar/source-control/listing/open-uncommitted-entry'
import {
  getAdjacentWorktreeDiffRow,
  isWorktreeDiffNavigationRow,
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

// The destination must open on the file it is reached from, never on the host that happens to be active.
function getActiveFileExecutionHostId(activeFile: OpenFile): ExecutionHostId | null {
  const provenanceHostId = activeFile.operationProvenance?.generation.route.executionHostId
  if (provenanceHostId) {
    return provenanceHostId
  }
  return activeFile.externalSshTargetId
    ? toSshExecutionHostId(activeFile.externalSshTargetId)
    : null
}

type WorktreeDiffFileArrival = {
  worktreeId: string
  rowKey: string
  direction: WorktreeDiffNavigationDirection
}

export function useWorktreeDiffFileNavigation({
  activeFile,
  requestedChangesMode
}: {
  activeFile: OpenFile | null
  requestedChangesMode: boolean
}): {
  canNavigateWorktreeFile: boolean
  handleNavigateWorktreeFile: (direction: WorktreeDiffNavigationDirection) => boolean
  isWorktreeFileNavigationSurface: boolean
  /** Direction to reveal in the hop target once its diff lands; null once the pane shows another file, disarming a stale reveal. */
  worktreeFileArrivalReveal: WorktreeDiffNavigationDirection | null
} {
  const [arrival, setArrival] = useState<WorktreeDiffFileArrival | null>(null)
  const worktreeId = activeFile?.worktreeId
  const activeWorktreeRoot = useAppStore((s) => {
    if (!activeFile || !worktreeId) {
      return null
    }
    const hostId =
      activeFile.operationProvenance?.generation.route.executionHostId ??
      (activeFile.externalSshTargetId
        ? toSshExecutionHostId(activeFile.externalSshTargetId)
        : undefined)
    return getWorktreeOnHostFromState(s, worktreeId, hostId)?.path ?? null
  })
  const activeEditorTargetGroupId = useAppStore((s) =>
    worktreeId
      ? (s.activeGroupIdByWorktree[worktreeId] ?? s.groupsByWorktree[worktreeId]?.[0]?.id)
      : undefined
  )
  const visibleRows = useAppStore((s) =>
    worktreeId ? s.sourceControlVisibleRowsByWorktree[worktreeId] : undefined
  )
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openFile = useAppStore((s) => s.openFile)
  const navigationRows = useMemo(
    () => visibleRows?.filter(isWorktreeDiffNavigationRow),
    [visibleRows]
  )
  const shownRowKeys = useMemo(
    () => navigationRows && new Set(navigationRows.map((row) => row.key)),
    [navigationRows]
  )
  const activeOpenRowKey = useMemo(() => {
    if (!activeFile) {
      return null
    }
    const signature = buildActiveOpenFileSignature(activeFile.diffSource, activeFile.relativePath)
    return buildActiveOpenRowKeys(signature, shownRowKeys).values().next().value ?? null
  }, [activeFile, shownRowKeys])
  // Remembered so a hop continues from where a row sat before the panel dropped it.
  const rememberedRowKeysRef = useRef<readonly string[] | null>(null)
  useEffect(() => {
    if (navigationRows?.some((row) => row.key === activeOpenRowKey)) {
      rememberedRowKeysRef.current = navigationRows.map((row) => row.key)
    }
  }, [activeOpenRowKey, navigationRows])

  const isWorktreeDiffSurface = Boolean(
    activeFile?.mode === 'diff' &&
    (activeFile.diffSource === 'unstaged' || activeFile.diffSource === 'staged')
  )
  // Stay eligible after a refresh drops the current file's own row; the resolver places it.
  const isEligibleChangesSurface = Boolean(requestedChangesMode && worktreeId)
  const isWorktreeFileNavigationSurface = isWorktreeDiffSurface || isEligibleChangesSurface
  const canNavigateWorktreeFile = Boolean(
    isWorktreeFileNavigationSurface && navigationRows?.some((row) => row.key !== activeOpenRowKey)
  )
  const arrivalReveal =
    arrival && worktreeId === arrival.worktreeId && activeOpenRowKey === arrival.rowKey
      ? arrival.direction
      : null

  const handleNavigateWorktreeFile = useCallback(
    (direction: WorktreeDiffNavigationDirection): boolean => {
      if (!activeFile || !worktreeId || !navigationRows || !canNavigateWorktreeFile) {
        return false
      }
      const target = getAdjacentWorktreeDiffRow({
        rows: navigationRows,
        currentKey: activeOpenRowKey ?? '',
        previousKeys: rememberedRowKeysRef.current,
        direction
      })
      const worktreeRoot =
        activeWorktreeRoot ?? inferWorktreeRoot(activeFile.filePath, activeFile.relativePath)
      const executionHostId = getActiveFileExecutionHostId(activeFile)
      if (!target || !worktreeRoot || !executionHostId) {
        return false
      }
      // A host the owner check rejects throws inside the opener; decline so the same-file wrap runs.
      try {
        if (target.entry.area === 'staged' || target.entry.status === 'deleted') {
          openUncommittedEntry(useAppStore.getState(), worktreeId, worktreeRoot, target.entry, {
            targetGroupId: activeEditorTargetGroupId,
            executionHostId,
            runtimeEnvironmentId: activeFile.runtimeEnvironmentId
          })
        } else {
          const openedFileId = openFile(
            {
              filePath: joinPath(worktreeRoot, target.entry.path),
              relativePath: target.entry.path,
              worktreeId,
              runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
              language: detectLanguage(target.entry.path),
              mode: 'edit'
            },
            { targetGroupId: activeEditorTargetGroupId, executionHostId }
          )
          setEditorViewMode(openedFileId, 'changes')
        }
      } catch {
        return false
      }
      setArrival({ worktreeId, rowKey: target.key, direction })
      return true
    },
    [
      activeEditorTargetGroupId,
      activeFile,
      activeOpenRowKey,
      activeWorktreeRoot,
      canNavigateWorktreeFile,
      navigationRows,
      openFile,
      setEditorViewMode,
      worktreeId
    ]
  )

  return {
    canNavigateWorktreeFile,
    handleNavigateWorktreeFile,
    isWorktreeFileNavigationSurface,
    worktreeFileArrivalReveal: arrivalReveal
  }
}
