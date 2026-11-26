import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import { editorViewPlacement } from '@/store/slices/editor/tabs/editor-view-placement'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { joinPath } from '@/lib/path'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/workspace/ownership/unified-tab-host-ownership'
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

type WorktreeDiffFileArrival = {
  worktreeId: string
  rowKey: string
  direction: WorktreeDiffNavigationDirection
}

/** The last row that matched a file, with the row order of that moment. */
type RetainedRow = {
  fileId: string
  rowKey: string
  rowKeys: readonly string[]
}

export function useWorktreeDiffFileNavigation({
  activeFile,
  viewStateId,
  requestedChangesMode
}: {
  activeFile: OpenFile | null
  /** The invoking pane's view; hops open in that pane, not in the worktree's last active one. */
  viewStateId: string | null
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
    const hostId = hasOpenFileExecutionHostEvidence(activeFile)
      ? getOpenFileExecutionHostId(activeFile)
      : undefined
    return getWorktreeOnHostFromState(s, worktreeId, hostId)?.path ?? null
  })
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
  const shownRowKey = useMemo(() => {
    if (!activeFile) {
      return null
    }
    const signature = buildActiveOpenFileSignature(activeFile.diffSource, activeFile.relativePath)
    return buildActiveOpenRowKeys(signature, shownRowKeys).values().next().value ?? null
  }, [activeFile, shownRowKeys])
  const workingTreeRowKey = useMemo(
    () =>
      activeFile?.mode === 'edit'
        ? (buildActiveOpenRowKeys(`unstaged::${activeFile.relativePath}`, shownRowKeys)
            .values()
            .next().value ?? null)
        : null,
    [activeFile, shownRowKeys]
  )
  // Kept so a hop still knows where the active file's row sat once the panel drops it.
  const [retainedRow, setRetainedRow] = useState<RetainedRow | null>(null)
  // Scoped to the file so a retained row can never place another file's hop. For an edit tab a working-tree
  // row shown again wins, then the retained row, because once staging removes that row the tab would match
  // the staged row instead. Diff tabs always follow the row of their own staging side.
  const retainedActiveRow = activeFile && retainedRow?.fileId === activeFile.id ? retainedRow : null
  const activeRowKey = workingTreeRowKey ?? retainedActiveRow?.rowKey ?? shownRowKey
  useEffect(() => {
    if (!activeFile || !navigationRows?.some((row) => row.key === activeRowKey)) {
      return
    }
    const fileId = activeFile.id
    const rowKey = activeRowKey ?? ''
    const rowKeys = navigationRows.map((row) => row.key)
    setRetainedRow((previous) =>
      previous?.fileId === fileId && previous.rowKey === rowKey && previous.rowKeys === rowKeys
        ? previous
        : { fileId, rowKey, rowKeys }
    )
  }, [activeFile, activeRowKey, navigationRows])

  const isWorktreeDiffSurface = Boolean(
    activeFile?.mode === 'diff' &&
    (activeFile.diffSource === 'unstaged' || activeFile.diffSource === 'staged')
  )
  // Stay eligible after a refresh drops the current file's own row; the resolver places it.
  const isEligibleChangesSurface = Boolean(requestedChangesMode && worktreeId)
  const isWorktreeFileNavigationSurface = isWorktreeDiffSurface || isEligibleChangesSurface
  const canNavigateWorktreeFile = Boolean(
    isWorktreeFileNavigationSurface && navigationRows?.some((row) => row.key !== activeRowKey)
  )
  const arrivalReveal =
    arrival && worktreeId === arrival.worktreeId && shownRowKey === arrival.rowKey
      ? arrival.direction
      : null

  const handleNavigateWorktreeFile = useCallback(
    (direction: WorktreeDiffNavigationDirection): boolean => {
      if (!activeFile || !worktreeId || !navigationRows || !canNavigateWorktreeFile) {
        return false
      }
      const target = getAdjacentWorktreeDiffRow({
        rows: navigationRows,
        currentKey: activeRowKey ?? '',
        previousKeys: retainedActiveRow?.rowKeys ?? null,
        direction
      })
      const worktreeRoot =
        activeWorktreeRoot ?? inferWorktreeRoot(activeFile.filePath, activeFile.relativePath)
      // With no ownership evidence the opener would guess from ambient state; decline instead.
      const executionHostId = hasOpenFileExecutionHostEvidence(activeFile)
        ? getOpenFileExecutionHostId(activeFile)
        : null
      if (!target || !worktreeRoot || !executionHostId) {
        return false
      }
      const { placementWorkspaceId, targetGroupId } = editorViewPlacement(
        useAppStore.getState(),
        activeFile,
        viewStateId
      )
      const options = {
        targetGroupId,
        placementWorkspaceId,
        executionHostId,
        runtimeEnvironmentId: activeFile.runtimeEnvironmentId
      }
      // A host the owner check rejects throws inside the opener; decline so the same-file wrap runs.
      try {
        if (target.entry.area === 'staged' || target.entry.status === 'deleted') {
          openUncommittedEntry(
            useAppStore.getState(),
            worktreeId,
            worktreeRoot,
            target.entry,
            options
          )
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
            options
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
      activeFile,
      activeRowKey,
      activeWorktreeRoot,
      canNavigateWorktreeFile,
      navigationRows,
      openFile,
      retainedActiveRow,
      setEditorViewMode,
      viewStateId,
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
