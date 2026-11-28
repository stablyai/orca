import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  activateAndRevealCycledRow,
  readCurrentSidebarWorkspace
} from './cycled-workspace-activation'
import {
  matchesSidebarWorkspaceOrigin,
  type SidebarKeyboardPreview,
  type SidebarWorkspacePreview
} from './worktree-keyboard-cycle'
import type { RenderedWorkspaceRow } from './worktree-sidebar-row-preference'

const PREVIEW_COMMIT_FIRST_REPEAT_MS = 120
const PREVIEW_COMMIT_MIN_MS = 50
const PREVIEW_COMMIT_MAX_MS = 200

/** Manages held-key sidebar highlight previews and commits them once key repeat stops. */
export function useSidebarWorkspacePreview(args: {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}) {
  const { activeWorktreeId, activeWorkspaceExecutionHostId } = args
  // Origin guard: another input switching workspaces or hosts mid-hold invalidates the preview, so it never pulls the user back.
  const previewRef = useRef<SidebarWorkspacePreview | null>(null)
  const [keyboardPreview, setKeyboardPreview] = useState<SidebarKeyboardPreview | null>(null)
  const previewCommitTimerRef = useRef<number | null>(null)
  const lastRepeatAtRef = useRef<number | null>(null)

  const clearPreviewCommitTimer = useCallback(() => {
    if (previewCommitTimerRef.current !== null) {
      window.clearTimeout(previewCommitTimerRef.current)
      previewCommitTimerRef.current = null
    }
  }, [])

  const dropPreview = useCallback(() => {
    clearPreviewCommitTimer()
    lastRepeatAtRef.current = null
    if (previewRef.current !== null) {
      previewRef.current = null
      setKeyboardPreview(null)
    }
  }, [clearPreviewCommitTimer])

  const commitPreview = useCallback(() => {
    const preview = previewRef.current
    dropPreview()
    const current = readCurrentSidebarWorkspace()
    if (matchesSidebarWorkspaceOrigin(preview, current.worktreeId, current.executionHostId)) {
      activateAndRevealCycledRow(preview.row)
    }
  }, [dropPreview])

  useEffect(() => clearPreviewCommitTimer, [clearPreviewCommitTimer])

  const readActivePreviewRow = useCallback((): RenderedWorkspaceRow | null => {
    const previewState = previewRef.current
    return matchesSidebarWorkspaceOrigin(
      previewState,
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    )
      ? previewState.row
      : null
  }, [activeWorktreeId, activeWorkspaceExecutionHostId])

  const startPreview = useCallback(
    (nextRow: RenderedWorkspaceRow, executionHostId: ExecutionHostId) => {
      const origin = {
        fromWorktreeId: activeWorktreeId,
        fromExecutionHostId: activeWorkspaceExecutionHostId
      }
      previewRef.current = { row: nextRow, ...origin }
      setKeyboardPreview({
        worktreeId: nextRow.worktree.id,
        executionHostId,
        ...origin
      })
      const now = performance.now()
      const repeatIntervalMs =
        lastRepeatAtRef.current === null ? null : now - lastRepeatAtRef.current
      lastRepeatAtRef.current = now
      clearPreviewCommitTimer()
      // Commit once repeats stop; macOS drops keyup while Cmd is held, so a missed repeat is the stop signal.
      previewCommitTimerRef.current = window.setTimeout(
        commitPreview,
        repeatIntervalMs === null
          ? PREVIEW_COMMIT_FIRST_REPEAT_MS
          : Math.min(PREVIEW_COMMIT_MAX_MS, Math.max(PREVIEW_COMMIT_MIN_MS, repeatIntervalMs * 1.5))
      )
    },
    [activeWorktreeId, activeWorkspaceExecutionHostId, clearPreviewCommitTimer, commitPreview]
  )

  const hasPendingPreview = useCallback(() => previewRef.current !== null, [])

  return {
    hasPendingPreview,
    readActivePreviewRow,
    startPreview,
    dropPreview,
    commitPreview,
    keyboardPreview: matchesSidebarWorkspaceOrigin(
      keyboardPreview,
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    )
      ? keyboardPreview
      : null
  }
}
