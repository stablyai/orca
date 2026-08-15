import { useCallback, useEffect } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import type { HostSectionRow } from '../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../worktree-list-groups'
import type { RenderRow } from '../worktree-list-virtual-rows'
import {
  getActiveCyclableWorktreeIds,
  getCyclableWorktreeIds,
  resolveCycledWorktreeId
} from '../worktree-keyboard-cycle'
import { findPreferredRenderRowIndexForWorktree } from './render-row-worktree-lookup'
import { isEditableTarget } from './sidebar-editable-target'

export function useWorktreeListKeyboardNavigation(args: {
  rows: HostSectionRow[]
  renderRows: RenderRow[]
  activeWorktreeId: string | null
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
    pinnedDisplayPolicy,
    virtualizer,
    scrollRef,
    activeModal,
    markDirectScrollInput
  } = args
  const keybindings = useAppStore((s) => s.keybindings)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down', activeOnly = false) => {
      // Why: cycle over the rows the sidebar actually rendered — collapsing a group
      // means "not now", and a rebuilt near-copy would drift from what is on screen
      // (host sections, pinned placement, folder workspaces).
      void agentStatusEpoch
      const worktreeIds = activeOnly
        ? getActiveCyclableWorktreeIds(rows, pinnedDisplayPolicy, {
            tabsByWorktree,
            ptyIdsByTabId,
            browserTabsByWorktree,
            worktreeIdsWithLiveAgent: getWorktreeIdsWithLiveAgent(
              useAppStore.getState().agentStatusByPaneKey,
              tabsByWorktree,
              Date.now()
            )
          })
        : getCyclableWorktreeIds(rows, pinnedDisplayPolicy)
      const nextWorktreeId = resolveCycledWorktreeId({
        worktreeIds,
        activeWorktreeId,
        direction
      })
      if (nextWorktreeId === null) {
        return
      }

      // Why: keyboard cycling is real navigation; route through the activation helper that records history.
      activateAndRevealWorktree(nextWorktreeId)

      const rowIndex = findPreferredRenderRowIndexForWorktree(
        renderRows,
        nextWorktreeId,
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
      virtualizer,
      pinnedDisplayPolicy,
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      agentStatusEpoch
    ]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeModal !== 'none' || isEditableTarget(e.target)) {
        return
      }

      const platform = getShortcutPlatform()
      if (keybindingMatchesAction('sidebar.focusWorktreeList', e, platform, keybindings)) {
        scrollRef.current?.focus()
        e.preventDefault()
        return
      }

      const navigation = keybindingMatchesAction('worktree.navigateUp', e, platform, keybindings)
        ? { direction: 'up' as const, activeOnly: false }
        : keybindingMatchesAction('worktree.navigateDown', e, platform, keybindings)
          ? { direction: 'down' as const, activeOnly: false }
          : keybindingMatchesAction('worktree.navigateActiveUp', e, platform, keybindings)
            ? { direction: 'up' as const, activeOnly: true }
            : keybindingMatchesAction('worktree.navigateActiveDown', e, platform, keybindings)
              ? { direction: 'down' as const, activeOnly: true }
              : null
      if (navigation) {
        markDirectScrollInput()
        navigateWorktree(navigation.direction, navigation.activeOnly)
        e.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [activeModal, keybindings, markDirectScrollInput, navigateWorktree, scrollRef])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (e.target !== e.currentTarget) {
          return
        }
        markDirectScrollInput()
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down')
        e.preventDefault()
      } else if (e.key === 'Enter') {
        const helper = document.querySelector(
          '.xterm-helper-textarea'
        ) as HTMLTextAreaElement | null
        if (helper) {
          helper.focus()
        }
        e.preventDefault()
      } else if (['PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        markDirectScrollInput()
      }
    },
    [markDirectScrollInput, navigateWorktree]
  )

  return { handleContainerKeyDown }
}
