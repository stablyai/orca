import { useWorktreeJumpPaletteStoreState } from './state/use-worktree-jump-palette-store-state'
import { useWorktreeJumpPaletteLocalState } from './state/use-worktree-jump-palette-local-state'
import { useWorktreeJumpPaletteFilter } from './results/use-worktree-jump-palette-filter'
import { useWorktreeJumpPaletteWorktrees } from './workspaces/use-worktree-jump-palette-worktrees'
import { useWorktreeJumpPaletteOpenTabs } from './tabs/use-worktree-jump-palette-open-tabs'
import { useWorktreeJumpPaletteRecentTabs } from './tabs/use-worktree-jump-palette-recent-tabs'
import { useWorktreeJumpPaletteProjectTargets } from './workspaces/use-worktree-jump-palette-project-targets'
import { useWorktreeJumpPaletteQuickActions } from './workspaces/use-worktree-jump-palette-quick-actions'
import { useWorktreeJumpPaletteExtraResults } from './results/use-worktree-jump-palette-extra-results'
import { useWorktreeJumpPaletteSections } from './results/use-worktree-jump-palette-sections'
import { useWorktreeJumpPaletteListEntries } from './results/use-worktree-jump-palette-list-entries'
import { useWorktreeJumpPaletteSelectionLifecycle } from './selection/use-worktree-jump-palette-selection-lifecycle'
import { useWorktreeJumpPaletteSelectionActions } from './selection/use-worktree-jump-palette-selection-actions'
import { useWorktreeJumpPaletteCreateAction } from './workspaces/use-worktree-jump-palette-create-action'
import { useWorktreeJumpPaletteTaskSearch } from './tasks/use-worktree-jump-palette-task-search'
import { useWorktreeJumpPaletteTaskUrl } from './tasks/use-worktree-jump-palette-task-url'
import { useWorkspaceEmojiShortcodeInput } from '@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput'
import { usePaletteSearchEvaluationContext } from '@/hooks/use-palette-search-evaluation-context'
import type { WorktreePaletteRequestGuard } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { useMemo } from 'react'

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
  const paletteEvaluationSnapshot = useMemo(
    () => ({
      query: localState.paletteSearchQuery,
      agentStatus: storeState.agentStatusByPaneKey,
      worktrees: storeState.workspaces,
      browserPages: storeState.browserPagesByWorkspace,
      browserWorkspaces: storeState.browserTabsByWorktree,
      openFiles: storeState.openFiles,
      retainedAgents: storeState.retainedAgentsByPaneKey,
      sleepingAgents: storeState.sleepingAgentSessionsByPaneKey,
      unifiedTabs: storeState.unifiedTabsByWorktree,
      visible
    }),
    [
      localState.paletteSearchQuery,
      storeState.agentStatusByPaneKey,
      storeState.workspaces,
      storeState.browserPagesByWorkspace,
      storeState.browserTabsByWorktree,
      storeState.openFiles,
      storeState.retainedAgentsByPaneKey,
      storeState.sleepingAgentSessionsByPaneKey,
      storeState.unifiedTabsByWorktree,
      visible
    ]
  )
  const paletteSearchContext = usePaletteSearchEvaluationContext(paletteEvaluationSnapshot)
  const evaluation = { paletteSearchContext }
  const taskUrl = useWorktreeJumpPaletteTaskUrl({
    visible,
    createWorktreeName: localState.createWorktreeName,
    taskSourceUrl: localState.taskSourceUrl,
    createLookupGuard
  })
  const filter = useWorktreeJumpPaletteFilter({ ...storeState, ...localState })
  const taskSearch = useWorktreeJumpPaletteTaskSearch({ ...storeState, ...localState, ...filter })
  const worktrees = useWorktreeJumpPaletteWorktrees({
    ...storeState,
    ...localState,
    ...filter,
    ...evaluation
  })
  const extraResults = useWorktreeJumpPaletteExtraResults({
    ...localState,
    ...filter,
    ...evaluation,
    visible
  })
  const openTabs = useWorktreeJumpPaletteOpenTabs({
    ...storeState,
    ...localState,
    ...filter,
    ...worktrees,
    ...extraResults,
    ...evaluation
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
    ...extraResults,
    ...taskUrl
  })
  const listEntries = useWorktreeJumpPaletteListEntries({
    ...localState,
    ...worktrees,
    ...openTabs,
    ...sections,
    ...taskSearch,
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
    ...taskSearch,
    ...taskUrl
  })
  const selectionActions = useWorktreeJumpPaletteSelectionActions({
    ...storeState,
    ...localState,
    ...quickActions,
    ...taskSearch,
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
    ...taskSearch,
    ...filter,
    ...worktrees,
    ...openTabs,
    ...recentTabs,
    ...projectTargets,
    ...quickActions,
    ...extraResults,
    ...sections,
    ...listEntries,
    ...selectionLifecycle,
    ...selectionActions,
    paletteNowMs: worktrees.hasQuery ? paletteSearchContext.nowMs : storeState.paletteNowMs,
    emojiInput,
    ...createAction
  }
}

export type WorktreeJumpPaletteController = ReturnType<typeof useWorktreeJumpPaletteController>
