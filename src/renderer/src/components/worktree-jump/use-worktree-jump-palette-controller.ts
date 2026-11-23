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
import { useWorktreeJumpPaletteBotScope } from './use-worktree-jump-palette-bot-scope'
import { useWorktreeJumpPaletteBotScopeEntries } from './worktree-jump-palette-bot-scope-entries'
import { useWorkspaceEmojiShortcodeInput } from '@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput'
import { usePaletteSearchEvaluationContext } from '@/lib/workspace/search/palette/use-palette-search-evaluation-context'
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
  // Showing only bots, every other section keeps the inputs it had, so none of its work reruns.
  const scoped = localState.scope === 'bots'
  const othersLocal = scoped
    ? {
        ...localState,
        query: localState.scopeHeldQuery,
        deferredQuery: localState.scopeHeldQuery,
        paletteSearchQuery: localState.scopeHeldQuery.trim(),
        createWorktreeName: ''
      }
    : localState
  const paletteEvaluationSnapshot = useMemo(
    () => ({
      query: othersLocal.paletteSearchQuery,
      agentStatus: storeState.agentStatusByPaneKey,
      worktrees: storeState.workspaces,
      browserPages: storeState.browserPagesByWorkspace,
      browserWorkspaces: storeState.browserTabsByWorktree,
      openFiles: storeState.openFiles,
      sleepingAgents: storeState.sleepingAgentSessionsByPaneKey,
      unifiedTabs: storeState.unifiedTabsByWorktree,
      visible
    }),
    [
      othersLocal.paletteSearchQuery,
      storeState.agentStatusByPaneKey,
      storeState.workspaces,
      storeState.browserPagesByWorkspace,
      storeState.browserTabsByWorktree,
      storeState.openFiles,
      storeState.sleepingAgentSessionsByPaneKey,
      storeState.unifiedTabsByWorktree,
      visible
    ]
  )
  const paletteSearchContext = usePaletteSearchEvaluationContext(paletteEvaluationSnapshot)
  const evaluation = { paletteSearchContext }
  const taskUrl = useWorktreeJumpPaletteTaskUrl({
    visible,
    createWorktreeName: othersLocal.createWorktreeName,
    taskSourceUrl: localState.taskSourceUrl,
    createLookupGuard
  })
  const filter = useWorktreeJumpPaletteFilter({ ...storeState, ...localState })
  // Showing only bots, task search is off: pending and debounced requests abort and no status shows.
  const taskSearch = useWorktreeJumpPaletteTaskSearch({
    ...storeState,
    ...othersLocal,
    ...filter,
    visible: visible && !scoped
  })
  const worktrees = useWorktreeJumpPaletteWorktrees({
    ...storeState,
    ...othersLocal,
    ...filter,
    ...evaluation
  })
  const extraResults = useWorktreeJumpPaletteExtraResults({
    ...localState,
    ...filter,
    ...evaluation,
    visible,
    scoped
  })
  const openTabs = useWorktreeJumpPaletteOpenTabs({
    ...storeState,
    ...othersLocal,
    ...filter,
    ...worktrees,
    ...extraResults,
    ...evaluation
  })
  const recentTabs = useWorktreeJumpPaletteRecentTabs({
    ...storeState,
    ...othersLocal,
    ...filter,
    ...worktrees,
    ...openTabs
  })
  const projectTargets = useWorktreeJumpPaletteProjectTargets({
    ...storeState,
    ...othersLocal,
    ...filter,
    ...worktrees
  })
  const quickActions = useWorktreeJumpPaletteQuickActions({
    ...storeState,
    ...othersLocal,
    ...worktrees,
    ...openTabs,
    ...projectTargets
  })
  const knowledge = useWorktreeJumpPaletteKnowledgeSearch({
    enabled: storeState.settings?.conversationKnowledgeEnabled === true && localState.knowledgeOnly,
    query: localState.deferredQuery,
    visible
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
    ...taskUrl,
    scoped
  })
  const botScopeEntries = useWorktreeJumpPaletteBotScopeEntries({
    ...extraResults,
    scoped,
    query: localState.query,
    visibleExtraSections: sections.paletteSections.visibleExtraSections,
    handleExpandSection: sections.handleExpandSection
  })
  const listEntries = useWorktreeJumpPaletteListEntries({
    ...localState,
    ...botScopeEntries,
    ...worktrees,
    ...openTabs,
    ...sections,
    ...taskSearch,
    ...taskUrl,
    ...knowledge
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
    ...taskUrl,
    ...knowledge
  })
  const botScope = useWorktreeJumpPaletteBotScope({
    ...localState,
    visible,
    handleQueryChange: selectionLifecycle.handleQueryChange
  })
  const selectionActions = useWorktreeJumpPaletteSelectionActions({
    ...storeState,
    ...localState,
    ...quickActions,
    ...taskSearch,
    ...selectionLifecycle,
    botScope
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
    ...knowledge,
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
    botScope,
    botScopeNote: botScopeEntries.botScopeNote,
    paletteNowMs: worktrees.hasQuery ? paletteSearchContext.nowMs : storeState.paletteNowMs,
    emojiInput,
    ...createAction
  }
}

export type WorktreeJumpPaletteController = ReturnType<typeof useWorktreeJumpPaletteController>
import { useWorktreeJumpPaletteKnowledgeSearch } from '../use-worktree-jump-palette-knowledge-search'
