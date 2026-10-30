import { textFieldClaimsActionKey } from '@/lib/file-search-shortcut-policy'
import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { focusRuntimeTerminalSurface } from '@/runtime/mounted-terminal-tab-registry'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  resolveCycledWorkspaceRow,
  type LastActiveCycleWorkspace
} from '../../worktree-keyboard-cycle'
import { findPreferredRenderRowIndexForWorktreeIdentity } from './render-row-lookup'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { useWorkspaceNeighborPrewarm } from './use-neighbor-prewarm'

const PREVIEW_COMMIT_FIRST_REPEAT_MS = 120
const PREVIEW_COMMIT_MIN_MS = 50
const PREVIEW_COMMIT_MAX_MS = 200

/** A held arrow previews its row as active before the workspace switch commits. */
export function withKeyboardPreview<
  P extends {
    activeWorktreeId: string | null
    activeWorkspaceExecutionHostId: ExecutionHostId | null
  }
>(props: P, preview: LastActiveCycleWorkspace | null): P {
  return preview
    ? {
        ...props,
        activeWorktreeId: preview.worktreeId,
        activeWorkspaceExecutionHostId: preview.executionHostId
      }
    : props
}

export function useWorktreeListKeyboardNavigation(args: {
  rows: HostSectionRow[]
  renderRows: RenderRow[]
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  scrollRef: React.RefObject<HTMLDivElement | null>
  activeModal: string
  markDirectScrollInput: () => void
}) {
  const {
    rows,
    renderRows,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    pinnedDisplayPolicy,
    virtualizer,
    scrollRef,
    activeModal,
    markDirectScrollInput
  } = args
  const keybindings = useAppStore((s) => s.keybindings)
  useWorkspaceNeighborPrewarm({
    rows,
    pinnedDisplayPolicy,
    activeWorktreeId,
    activeWorkspaceExecutionHostId
  })
  const lastActiveWorkspaceRef = useRef<LastActiveCycleWorkspace | null>(null)
  useEffect(() => {
    // Closing the last tab clears both selection and host; history retains only the id.
    if (activeWorktreeId !== null) {
      lastActiveWorkspaceRef.current = {
        worktreeId: activeWorktreeId,
        executionHostId: activeWorkspaceExecutionHostId
      }
    }
  }, [activeWorktreeId, activeWorkspaceExecutionHostId])

  // Held arrows move only the sidebar highlight; the workspace under it switches once the repeat stops.
  // fromWorktreeId: another input switching workspaces mid-hold invalidates the preview, so it never pulls the user back.
  const previewRef = useRef<{ worktree: Worktree; fromWorktreeId: string | null } | null>(null)
  const [keyboardPreview, setKeyboardPreview] = useState<
    (LastActiveCycleWorkspace & { fromWorktreeId: string | null }) | null
  >(null)
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
    if (preview && preview.fromWorktreeId === useAppStore.getState().activeWorktreeId) {
      void activateWorktreeFromSidebar(preview.worktree.id, preview.worktree.hostId)
    }
  }, [dropPreview])
  useEffect(() => clearPreviewCommitTimer, [clearPreviewCommitTimer])

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down', isRepeat: boolean) => {
      const { worktreeNavHistory, worktreeNavHistoryIndex } = useAppStore.getState()
      const previewState = previewRef.current
      const preview =
        previewState && previewState.fromWorktreeId === activeWorktreeId
          ? previewState.worktree
          : null
      // Cycle actual rendered rows so collapse, pins, hosts and folder workspaces stay aligned with the screen.
      const nextWorktree = resolveCycledWorkspaceRow({
        rows,
        pinnedDisplayPolicy,
        activeWorktreeId: preview ? preview.id : activeWorktreeId,
        activeWorkspaceExecutionHostId: preview
          ? (preview.hostId ?? null)
          : activeWorkspaceExecutionHostId,
        lastActiveWorkspace: lastActiveWorkspaceRef.current,
        navHistory: worktreeNavHistory,
        navHistoryIndex: worktreeNavHistoryIndex,
        direction
      })?.worktree
      if (!nextWorktree) {
        return
      }

      if (isRepeat) {
        previewRef.current = { worktree: nextWorktree, fromWorktreeId: activeWorktreeId }
        setKeyboardPreview({
          worktreeId: nextWorktree.id,
          executionHostId: nextWorktree.hostId ?? null,
          fromWorktreeId: activeWorktreeId
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
            : Math.min(
                PREVIEW_COMMIT_MAX_MS,
                Math.max(PREVIEW_COMMIT_MIN_MS, repeatIntervalMs * 1.5)
              )
        )
      } else {
        dropPreview()
        void activateWorktreeFromSidebar(nextWorktree.id, nextWorktree.hostId)
      }

      const rowIndex = findPreferredRenderRowIndexForWorktreeIdentity(
        renderRows,
        nextWorktree,
        pinnedDisplayPolicy
      )
      if (rowIndex !== -1) {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
      }
    },
    [
      rows,
      renderRows,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      virtualizer,
      pinnedDisplayPolicy,
      clearPreviewCommitTimer,
      commitPreview,
      dropPreview
    ]
  )

  useEffect(() => {
    const endListNavigation = () => {
      scrollRef.current?.removeAttribute('data-keyboard-navigation')
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || activeModal !== 'none') {
        return
      }

      const platform = getShortcutPlatform()
      if (
        keybindingMatchesAction('sidebar.focusWorktreeList', e, platform, keybindings) &&
        !textFieldClaimsActionKey(e, 'sidebar.focusWorktreeList') &&
        !hasVisibleOverlay()
      ) {
        scrollRef.current?.focus()
        e.preventDefault()
        return
      }

      const direction = keybindingMatchesAction('worktree.navigateUp', e, platform, keybindings)
        ? 'up'
        : keybindingMatchesAction('worktree.navigateDown', e, platform, keybindings)
          ? 'down'
          : null
      const directionAction = direction === 'up' ? 'worktree.navigateUp' : 'worktree.navigateDown'
      if (direction && !textFieldClaimsActionKey(e, directionAction) && !hasVisibleOverlay()) {
        endListNavigation()
        markDirectScrollInput()
        navigateWorktree(direction, e.repeat)
        e.preventDefault()
        // Why: a user-bound chord fired from a field must not also reach the field's own handler.
        e.stopPropagation()
      }
    }

    const handleKeyUp = () => {
      if (previewRef.current !== null) {
        commitPreview()
      }
    }
    const handlePointerDown = () => {
      endListNavigation()
      dropPreview()
    }

    addAppKeyListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp, { capture: true })
    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('focusout', endListNavigation, { capture: true })
    return () => {
      removeAppKeyListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp, { capture: true })
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('focusout', endListNavigation, { capture: true })
    }
  }, [
    activeModal,
    commitPreview,
    dropPreview,
    keybindings,
    markDirectScrollInput,
    navigateWorktree,
    scrollRef
  ])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.target !== e.currentTarget ||
        activeModal !== 'none' ||
        hasVisibleOverlay()
      ) {
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // The focused DOM node owns navigation, including while a new terminal mounts.
        e.currentTarget.setAttribute('data-keyboard-navigation', '')
        markDirectScrollInput()
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down', e.repeat)
        e.preventDefault()
      } else if (e.key === 'Enter') {
        if (previewRef.current !== null) {
          commitPreview()
        }
        const { activeView, activeWorktreeId, activeTabType, activeTabId, tabsByWorktree } =
          useAppStore.getState()
        if (
          activeView === 'terminal' &&
          activeTabType === 'terminal' &&
          activeWorktreeId &&
          activeTabId &&
          tabsByWorktree[activeWorktreeId]?.some((tab) => tab.id === activeTabId)
        ) {
          // The registered manager owns the active split; unavailable surfaces keep list focus.
          focusRuntimeTerminalSurface(activeTabId, null, activeWorktreeId)
        }
        e.preventDefault()
      } else if (['PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        markDirectScrollInput()
      }
    },
    [activeModal, commitPreview, markDirectScrollInput, navigateWorktree]
  )

  return {
    handleContainerKeyDown,
    keyboardPreview: keyboardPreview?.fromWorktreeId === activeWorktreeId ? keyboardPreview : null
  }
}
