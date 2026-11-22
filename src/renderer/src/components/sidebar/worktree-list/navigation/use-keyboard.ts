import { textFieldClaimsActionKey } from '@/lib/keyboard/text-field-shortcut-policy'
import React, { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { getWorktreeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import type { LastActiveCycleWorkspace } from './worktree-keyboard-cycle'
import { resolveCycledWorkspaceRow } from './worktree-keyboard-cycle'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { focusActiveWorkspaceSurfaceFromSidebar, focusProjects } from './focus-workspace-surface'
import type { WorktreeContextMenuDeleteIntent } from '../../workspace-actions/context-menu/worktree-context-menu-delete-intent'
import { useSidebarWorkspaceDeleteKeyboard } from './use-sidebar-workspace-delete-keyboard'
import { textInputOwnsComposition } from '../../../../../../shared/keybindings/text-input-shortcut-policy'
import { useWorkspaceNeighborPrewarm } from './use-neighbor-prewarm'
import {
  activateAndRevealCycledRow,
  clearPendingBotGroupCycleRow,
  readGlobalSidebarCycleOptions,
  readPendingBotGroupCycleRow
} from './cycled-workspace-activation'
import { useSidebarWorkspacePreview } from './use-sidebar-workspace-preview'

export { withKeyboardPreview } from './worktree-keyboard-cycle'

export function useWorktreeListKeyboardNavigation(args: {
  rows: HostSectionRow[]
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  scrollRef: React.RefObject<HTMLDivElement | null>
  activeModal: string
  markDirectScrollInput: () => void
  onKeyboardSelect?: (worktree: Worktree) => void
  focusedWorktree?: Worktree | null
  focusedWorkspaceExecutionHostId?: ExecutionHostId | null
  resolveDeleteIntent?: () => WorktreeContextMenuDeleteIntent | null
}) {
  const {
    rows,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    pinnedDisplayPolicy,
    scrollRef,
    activeModal,
    markDirectScrollInput,
    onKeyboardSelect,
    focusedWorktree,
    focusedWorkspaceExecutionHostId,
    resolveDeleteIntent
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
    clearPendingBotGroupCycleRow()
  }, [activeWorktreeId, activeWorkspaceExecutionHostId])

  const {
    hasPendingPreview,
    readActivePreviewRow,
    startPreview,
    dropPreview,
    commitPreview,
    keyboardPreview
  } = useSidebarWorkspacePreview({ activeWorktreeId, activeWorkspaceExecutionHostId })
  const { handleDeleteKeyDown, handleContainerKeyUp, resetDeleteGesture } =
    useSidebarWorkspaceDeleteKeyboard({ keybindings, resolveDeleteIntent, dropPreview })

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down', isRepeat: boolean, selectInList = false) => {
      const { worktreeNavHistory, worktreeNavHistoryIndex } = useAppStore.getState()
      const preview = readActivePreviewRow()
      // BotGroup opens wait for folder fetch, so chain non-repeated presses until activation settles.
      const pendingBotGroup = !selectInList && !isRepeat ? readPendingBotGroupCycleRow() : null
      const anchorRow = preview ?? pendingBotGroup
      const focused = selectInList ? focusedWorktree : null
      // Cycle actual rendered rows so collapse, pins, hosts, Bots and folder workspaces stay aligned with the screen.
      const nextRow = resolveCycledWorkspaceRow({
        rows,
        pinnedDisplayPolicy,
        ...(selectInList ? {} : readGlobalSidebarCycleOptions()),
        activeWorktreeId: anchorRow?.worktree.id ?? focused?.id ?? activeWorktreeId,
        activeWorkspaceExecutionHostId: anchorRow
          ? getWorktreeExecutionHostId(anchorRow.worktree, anchorRow.repo)
          : focused
            ? (focusedWorkspaceExecutionHostId ?? null)
            : activeWorkspaceExecutionHostId,
        lastActiveWorkspace: lastActiveWorkspaceRef.current,
        navHistory: worktreeNavHistory,
        navHistoryIndex: worktreeNavHistoryIndex,
        direction
      })
      if (!nextRow) {
        return
      }

      const nextWorktree = nextRow.worktree
      if (selectInList) {
        onKeyboardSelect?.(nextWorktree)
      }
      const executionHostId = getWorktreeExecutionHostId(nextWorktree, nextRow.repo)
      if (isRepeat) {
        startPreview(nextRow, executionHostId)
        if (nextRow.section !== 'bots') {
          useAppStore.getState().revealWorktreeInSidebar(nextWorktree.id, {
            behavior: 'auto',
            executionHostId,
            rowKey: nextRow.rowKey
          })
        }
      } else {
        dropPreview()
        activateAndRevealCycledRow(nextRow)
      }
    },
    [
      rows,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      pinnedDisplayPolicy,
      onKeyboardSelect,
      focusedWorktree,
      focusedWorkspaceExecutionHostId,
      readActivePreviewRow,
      startPreview,
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
        focusProjects(() => scrollRef.current)
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
      if (hasPendingPreview()) {
        commitPreview()
      }
    }
    // Why every press: a click on a row or agent row hands keys back to the workspace; modifier selection reclaims them on click.
    const handlePointerDown = () => {
      endListNavigation()
      resetDeleteGesture()
      dropPreview()
    }
    const handleFocusOut = (event: FocusEvent) => {
      if (event.target === scrollRef.current) {
        endListNavigation()
        resetDeleteGesture()
      }
    }
    const handleBlur = () => {
      endListNavigation()
      resetDeleteGesture()
    }

    addAppKeyListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp, { capture: true })
    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('focusout', handleFocusOut, { capture: true })
    window.addEventListener('blur', handleBlur)
    return () => {
      removeAppKeyListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp, { capture: true })
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('focusout', handleFocusOut, { capture: true })
      window.removeEventListener('blur', handleBlur)
      resetDeleteGesture()
    }
  }, [
    activeModal,
    commitPreview,
    dropPreview,
    hasPendingPreview,
    keybindings,
    markDirectScrollInput,
    navigateWorktree,
    scrollRef,
    resetDeleteGesture
  ])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (textInputOwnsComposition(e.nativeEvent)) {
        resetDeleteGesture()
        return
      }
      if (
        e.defaultPrevented ||
        e.target !== e.currentTarget ||
        activeModal !== 'none' ||
        hasVisibleOverlay()
      ) {
        return
      }
      if (handleDeleteKeyDown(e)) {
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // The focused DOM node owns navigation, including while a new terminal mounts.
        e.currentTarget.setAttribute('data-keyboard-navigation', '')
        markDirectScrollInput()
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down', e.repeat, true)
        e.preventDefault()
      } else if (e.key === 'Enter') {
        if (hasPendingPreview()) {
          commitPreview()
        }
        focusActiveWorkspaceSurfaceFromSidebar(e.currentTarget)
        e.preventDefault()
      } else if (['PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        markDirectScrollInput()
      }
    },
    [
      activeModal,
      commitPreview,
      handleDeleteKeyDown,
      hasPendingPreview,
      resetDeleteGesture,
      markDirectScrollInput,
      navigateWorktree
    ]
  )

  return {
    handleContainerKeyDown,
    handleContainerKeyUp,
    handleContainerBlur: resetDeleteGesture,
    keyboardPreview
  }
}
