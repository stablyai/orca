import { useWorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import { useWorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import { useWorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import { useWorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import { useWorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'
import { useWorktreeJumpPaletteRecentTabs } from './use-worktree-jump-palette-recent-tabs'
import { useWorktreeJumpPaletteProjectTargets } from './use-worktree-jump-palette-project-targets'
import { useWorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import { useWorktreeJumpPaletteSections } from './use-worktree-jump-palette-sections'
import { useWorktreeJumpPaletteListEntries } from './use-worktree-jump-palette-list-entries'
import { useWorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'
import { useWorktreeJumpPaletteSelectionActions } from './use-worktree-jump-palette-selection-actions'
import { useWorktreeJumpPaletteCreateAction } from './use-worktree-jump-palette-create-action'
import { useWorktreeJumpPaletteTaskUrl } from './use-worktree-jump-palette-task-url'
import { useWorkspaceEmojiShortcodeInput } from '@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput'

export function useWorktreeJumpPaletteController({
  visible,
  lingering,
  createLookupGuard
}: {
  visible: boolean
  lingering: boolean
  createLookupGuard: WorktreePaletteRequestGuard
}) {
  const storeState = useWorktreeJumpPaletteStoreState({ visible, lingering })
  const localState = useWorktreeJumpPaletteLocalState({ createLookupGuard, visible })
  const taskUrl = useWorktreeJumpPaletteTaskUrl({
    visible,
    createWorktreeName: localState.createWorktreeName,
    taskSourceUrl: localState.taskSourceUrl,
    createLookupGuard
  })
  const filter = useWorktreeJumpPaletteFilter({ ...storeState, ...localState })
  const worktrees = useWorktreeJumpPaletteWorktrees({
    ...storeState,
    ...localState,
    ...filter
  })
  const openTabs = useWorktreeJumpPaletteOpenTabs({
    ...storeState,
    ...localState,
    ...filter,
    ...worktrees
  })
  const recentTabs = useWorktreeJumpPaletteRecentTabs({
    ...storeState,
    ...localState,
    ...filter,
    ...worktrees,
    ...openTabs
  })
  const projectTargets = useWorktreeJumpPaletteProjectTargets({
    ...storeState,
    ...localState,
    ...filter,
    ...worktrees
  })
  const quickActions = useWorktreeJumpPaletteQuickActions({
    ...storeState,
    ...localState,
    ...worktrees,
    ...openTabs,
    ...projectTargets
  })
  const sections = useWorktreeJumpPaletteSections({
    ...localState,
    ...filter,
    ...worktrees,
    ...openTabs,
    ...recentTabs,
    ...projectTargets,
    ...quickActions,
    ...taskUrl
  })
  const listEntries = useWorktreeJumpPaletteListEntries({
    ...localState,
    ...worktrees,
    ...openTabs,
    ...sections,
    ...taskUrl
  })
  const selectionLifecycle = useWorktreeJumpPaletteSelectionLifecycle({
    ...storeState,
    ...localState,
    ...filter,
    ...worktrees,
    ...openTabs,
    ...recentTabs,
    ...projectTargets,
    ...quickActions,
    ...sections,
    ...listEntries,
    ...taskUrl
  })
  const selectionActions = useWorktreeJumpPaletteSelectionActions({
    ...storeState,
    ...localState,
    ...quickActions,
    ...selectionLifecycle
  })
  const emojiInput = useWorkspaceEmojiShortcodeInput({
    inputRef: localState.inputRef,
    onValueChange: selectionLifecycle.handleQueryChange,
    value: localState.query
  })
  const createAction = useWorktreeJumpPaletteCreateAction({
    ...storeState,
    ...localState,
    ...filter,
    ...worktrees,
    ...quickActions,
    ...sections,
    ...selectionLifecycle,
    ...selectionActions,
    ...taskUrl
  })

  return {
    ...storeState,
    ...localState,
    ...taskUrl,
    ...filter,
    ...worktrees,
    ...openTabs,
    ...recentTabs,
    ...projectTargets,
    ...quickActions,
    ...sections,
    ...listEntries,
    ...selectionLifecycle,
    ...selectionActions,
    emojiInput,
    ...createAction
  }
}

export type WorktreeJumpPaletteController = ReturnType<typeof useWorktreeJumpPaletteController>
import type { WorktreePaletteRequestGuard } from '@/lib/worktree-palette-create-action'
