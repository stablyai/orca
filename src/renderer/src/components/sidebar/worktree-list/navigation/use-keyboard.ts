import { useCallback, useEffect } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { focusRuntimeTerminalSurface } from '@/runtime/sync-runtime-graph'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import {
  keybindingMatchesAction,
  type KeybindingMatchOptions
} from '../../../../../../shared/keybindings'
import { resolveKeyboardShortcutSurface } from '@/lib/keyboard-shortcut-surface'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import type { HostSectionRow } from '../../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import type { RenderRow } from '../listing/render-row'
import {
  getCyclableRowIdentity,
  getCyclableWorktreeRows,
  resolveActiveCycleIdentity,
  resolveCycledWorktreeId
} from '../../worktree-keyboard-cycle'
import { findPreferredRenderRowIndexForWorktreeIdentity } from './render-row-lookup'

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

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down') => {
      // Why: cycle over the rows the sidebar actually rendered — collapsing a group
      // means "not now", and a rebuilt near-copy would drift from what is on screen
      // (host sections, pinned placement, folder workspaces).
      const worktreeRows = getCyclableWorktreeRows(rows, pinnedDisplayPolicy)
      const nextWorktreeIdentity = resolveCycledWorktreeId({
        worktreeIds: worktreeRows.map(getCyclableRowIdentity),
        activeWorktreeId: resolveActiveCycleIdentity({
          rows: worktreeRows,
          activeWorktreeId,
          activeWorkspaceExecutionHostId
        }),
        direction
      })
      if (nextWorktreeIdentity === null) {
        return
      }
      const nextWorktree = worktreeRows.find(
        (row) => getCyclableRowIdentity(row) === nextWorktreeIdentity
      )?.worktree
      if (!nextWorktree) {
        return
      }

      void activateWorktreeFromSidebar(nextWorktree.id, nextWorktree.hostId)

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
      pinnedDisplayPolicy
    ]
  )

  useEffect(() => {
    const endListNavigation = () => {
      scrollRef.current?.removeAttribute('data-keyboard-navigation')
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeModal !== 'none') {
        return
      }
      const surface = resolveKeyboardShortcutSurface(e.target)
      if (surface === 'blocked' || (surface === 'search-field' && isImeOwnedKeyboardEvent(e))) {
        return
      }
      const options: KeybindingMatchOptions = {
        context: surface
      }

      const platform = getShortcutPlatform()
      if (
        keybindingMatchesAction('sidebar.focusWorktreeList', e, platform, keybindings, options) &&
        !hasVisibleOverlay()
      ) {
        scrollRef.current?.focus()
        e.preventDefault()
        return
      }

      const direction = keybindingMatchesAction(
        'worktree.navigateUp',
        e,
        platform,
        keybindings,
        options
      )
        ? 'up'
        : keybindingMatchesAction('worktree.navigateDown', e, platform, keybindings, options)
          ? 'down'
          : null
      if (direction && !hasVisibleOverlay()) {
        endListNavigation()
        markDirectScrollInput()
        navigateWorktree(direction)
        e.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('pointerdown', endListNavigation, { capture: true })
    window.addEventListener('focusout', endListNavigation, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('pointerdown', endListNavigation, { capture: true })
      window.removeEventListener('focusout', endListNavigation, { capture: true })
    }
  }, [activeModal, keybindings, markDirectScrollInput, navigateWorktree, scrollRef])

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
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down')
        e.preventDefault()
      } else if (e.key === 'Enter') {
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
    [activeModal, markDirectScrollInput, navigateWorktree]
  )

  return { handleContainerKeyDown }
}
