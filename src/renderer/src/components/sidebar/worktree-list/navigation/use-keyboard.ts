import { useCallback, useEffect } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings'
import type { HostSectionRow } from '../../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import type { RenderRow } from '../listing/render-row'
import { getCyclableWorktreeIds, resolveCycledWorktreeId } from '../../worktree-keyboard-cycle'
import { findPreferredRenderRowIndexForWorktree } from './render-row-lookup'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm's hidden input textarea isn't a real text field; treating it as one would block sidebar shortcuts.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

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

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down') => {
      // Why: cycle over the rows the sidebar actually rendered — collapsing a group
      // means "not now", and a rebuilt near-copy would drift from what is on screen
      // (host sections, pinned placement, folder workspaces).
      const nextWorktreeId = resolveCycledWorktreeId({
        worktreeIds: getCyclableWorktreeIds(rows, pinnedDisplayPolicy),
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
    [rows, renderRows, activeWorktreeId, virtualizer, pinnedDisplayPolicy]
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

      const direction = keybindingMatchesAction('worktree.navigateUp', e, platform, keybindings)
        ? 'up'
        : keybindingMatchesAction('worktree.navigateDown', e, platform, keybindings)
          ? 'down'
          : null
      if (direction) {
        markDirectScrollInput()
        navigateWorktree(direction)
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
