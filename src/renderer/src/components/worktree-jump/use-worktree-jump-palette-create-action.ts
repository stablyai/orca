import { useCallback, useEffect, useLayoutEffect } from 'react'
import { subscribeCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import type { WorktreeJumpPaletteSections } from './use-worktree-jump-palette-sections'
import type { WorktreeJumpPaletteSelectionActions } from './use-worktree-jump-palette-selection-actions'
import type { WorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import type { WorktreeJumpPaletteTaskUrl } from './use-worktree-jump-palette-task-url'
import { createWorktreeJumpPaletteWorktreeHandler } from './worktree-jump-palette-create-worktree'

type WorktreeJumpPaletteCreateActionInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteLocalState &
  WorktreeJumpPaletteFilter &
  WorktreeJumpPaletteQuickActions &
  WorktreeJumpPaletteSections &
  WorktreeJumpPaletteSelectionActions &
  WorktreeJumpPaletteSelectionLifecycle &
  WorktreeJumpPaletteTaskUrl &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'>

export function useWorktreeJumpPaletteCreateAction({
  digitShortcutItemsRef,
  paletteSections,
  visible,
  hasQuery,
  query,
  handleSelectItem,
  inputRef,
  setDialogElement,
  ...createWorktreeInput
}: WorktreeJumpPaletteCreateActionInput) {
  useLayoutEffect(() => {
    digitShortcutItemsRef.current = paletteSections.visibleOpenTabItems
  }, [digitShortcutItemsRef, paletteSections])
  useEffect(() => {
    if (!visible || hasQuery || query.length > 0) {
      return
    }
    return subscribeCmdJRowIndexJump((index) => {
      const item = digitShortcutItemsRef.current[index]
      if (item) {
        handleSelectItem(item)
      }
    })
  }, [digitShortcutItemsRef, handleSelectItem, hasQuery, query.length, visible])

  const handleCreateWorktree = createWorktreeJumpPaletteWorktreeHandler(createWorktreeInput)

  const handleCloseAutoFocus = useCallback((event: Event) => event.preventDefault(), [])
  const focusPaletteInput = useCallback(() => inputRef.current?.focus(), [inputRef])
  const setDialogElementFromNode = useCallback(
    (node: HTMLDivElement | null) =>
      setDialogElement(node?.closest<HTMLElement>('[role="dialog"]') ?? null),
    [setDialogElement]
  )
  const handleOpenAutoFocus = useCallback((_event: Event) => {}, [])
  return {
    handleCreateWorktree,
    handleCloseAutoFocus,
    focusPaletteInput,
    setDialogElementFromNode,
    handleOpenAutoFocus
  }
}

export type WorktreeJumpPaletteCreateAction = ReturnType<typeof useWorktreeJumpPaletteCreateAction>
