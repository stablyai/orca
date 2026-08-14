import { useCallback, useEffect, type MutableRefObject } from 'react'
import type { RenderRow } from './worktree-list-virtual-rows'
import type { HostSectionRow } from './host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from './worktree-list-groups'
import { getCyclableWorktreeIds, resolveCycledWorktreeId } from './worktree-keyboard-cycle'
import { findPreferredRenderRowIndexForWorktree } from './worktree-list-render-row-model'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { isEditableTarget } from './worktree-list-dom-activation'
import type { AppState } from '@/store/types'

type Virtualizer = { scrollToIndex: (index: number, options: { align: 'auto' }) => void }
type Args = {
  rows: readonly HostSectionRow[]
  renderRows: readonly RenderRow[]
  activeWorktreeId: string | null
  virtualizer: Virtualizer
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  activeModal: string
  keybindings: AppState['keybindings']
  scrollRef: MutableRefObject<HTMLDivElement | null>
  markDirectScrollInput: () => void
  markScrollMovement: () => void
}

export function useWorktreeListKeyboard(args: Args) {
  const {
    rows,
    renderRows,
    activeWorktreeId,
    virtualizer,
    pinnedDisplayPolicy,
    activeModal,
    keybindings,
    scrollRef,
    markDirectScrollInput,
    markScrollMovement
  } = args
  const navigateWorktree = useCallback(
    (direction: 'up' | 'down') => {
      // Why: cycle over the rows the sidebar actually rendered — collapsing a group
      // means "not now", and a rebuilt near-copy would drift from what is on screen.
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
  const focusWorktreeList = useCallback(() => scrollRef.current?.focus(), [scrollRef])
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeModal !== 'none' || isEditableTarget(event.target)) {
        return
      }
      const platform = getShortcutPlatform()
      if (keybindingMatchesAction('sidebar.focusWorktreeList', event, platform, keybindings)) {
        focusWorktreeList()
        event.preventDefault()
        return
      }
      const direction = keybindingMatchesAction('worktree.navigateUp', event, platform, keybindings)
        ? 'up'
        : keybindingMatchesAction('worktree.navigateDown', event, platform, keybindings)
          ? 'down'
          : null
      if (direction) {
        markDirectScrollInput()
        navigateWorktree(direction)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [activeModal, focusWorktreeList, keybindings, markDirectScrollInput, navigateWorktree])
  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (event.target !== event.currentTarget) {
          return
        }
        markDirectScrollInput()
        navigateWorktree(event.key === 'ArrowUp' ? 'up' : 'down')
        event.preventDefault()
      } else if (event.key === 'Enter') {
        const helper = document.querySelector(
          '.xterm-helper-textarea'
        ) as HTMLTextAreaElement | null
        helper?.focus()
        event.preventDefault()
      } else if (['PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        markDirectScrollInput()
      }
    },
    [markDirectScrollInput, navigateWorktree]
  )
  const handleScrollPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const scrollbarWidth = event.currentTarget.offsetWidth - event.currentTarget.clientWidth
      if (scrollbarWidth <= 0) {
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX >= rect.right - scrollbarWidth) {
        markDirectScrollInput()
      }
    },
    [markDirectScrollInput]
  )
  const handleScroll = useCallback(() => markScrollMovement(), [markScrollMovement])
  return { handleContainerKeyDown, handleScrollPointerDown, handleScroll }
}
