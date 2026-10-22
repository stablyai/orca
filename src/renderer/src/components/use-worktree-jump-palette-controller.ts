import { useWorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import { useWorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import { useWorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import { useWorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import { useWorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'
import { useWorktreeJumpPaletteTranscriptMatches } from './use-worktree-jump-palette-transcript-matches'
import { useWorktreeJumpPaletteRecentTabs } from './use-worktree-jump-palette-recent-tabs'
import { useWorktreeJumpPaletteProjectTargets } from './use-worktree-jump-palette-project-targets'
import { useWorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import { useWorktreeJumpPaletteSections } from './use-worktree-jump-palette-sections'
import { useWorktreeJumpPaletteListEntries } from './use-worktree-jump-palette-list-entries'
import { useWorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'
import { useWorktreeJumpPaletteSelectionActions } from './use-worktree-jump-palette-selection-actions'
import { useWorktreeJumpPaletteCreateAction } from './use-worktree-jump-palette-create-action'
import { useWorktreeJumpPaletteTaskSearch } from './use-worktree-jump-palette-task-search'
import { useWorktreeJumpPaletteTaskUrl } from './use-worktree-jump-palette-task-url'
import { useWorkspaceEmojiShortcodeInput } from '@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput'
import { usePaletteSearchEvaluationContext } from '@/hooks/use-palette-search-evaluation-context'
import type { WorktreePaletteRequestGuard } from '@/lib/worktree-palette-create-action'
import { useMemo } from 'react'
import { useWorktreeJumpPaletteObservedPrefix } from './use-worktree-jump-palette-observed-prefix'

export function useWorktreeJumpPaletteController({
  visible,
  lingering,
  createLookupGuard
}: {
  visible: boolean
  lingering: boolean
  createLookupGuard: WorktreePaletteRequestGuard
}) {
  const localState = useWorktreeJumpPaletteLocalState({ createLookupGuard, visible })
  const storeState = useWorktreeJumpPaletteStoreState({
    visible,
    lingering,
    query: localState.query
  })
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
  const transcriptMatches = useWorktreeJumpPaletteTranscriptMatches({
    ...storeState,
    agentStatusByPaneKey: storeState.transcriptAgentStatusByPaneKey,
    ...localState,
    ...filter
  })
  const observedPrefix = useWorktreeJumpPaletteObservedPrefix({
    generationKey: JSON.stringify([
      transcriptMatches.transcriptGenerationKey,
      transcriptMatches.transcriptDisplayKey
    ]),
    listRef: localState.listRef,
    active: storeState.visible && localState.query.trim().length > 0
  })
  const openTabs = useWorktreeJumpPaletteOpenTabs({
    ...storeState,
    ...localState,
    ...filter,
    ...worktrees,
    ...evaluation,
    ...transcriptMatches,
    ...observedPrefix
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
    ...observedPrefix,
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
    ...observedPrefix,
    ...localState,
    ...worktrees,
    ...openTabs,
    ...sections,
    ...taskSearch,
    ...taskUrl
  })
  const selectionLifecycle = useWorktreeJumpPaletteSelectionLifecycle({
    ...observedPrefix,
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
    ...observedPrefix,
    ...transcriptMatches,
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
