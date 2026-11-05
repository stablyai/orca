import { useCallback, useLayoutEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getStructuredChatTabNames } from '@/runtime/structured-chat-name-observation'
import {
  buildPaletteAgentThreads,
  usePaletteAgentThreads
} from '@/components/cmd-j/palette-agent-threads'
import { collectHiddenChildAgentPaneKeys } from '@/components/activity/activity-thread-child-agent'
import { createActivityThreadActions } from '@/components/activity/activity-thread-actions'
import type { AgentPaneThread } from '@/components/activity/activity-thread-types'
import {
  buildPaletteAgentGroups,
  type PaletteAgentGroupKey
} from '@/components/cmd-j/palette-agent-groups'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { AGENT_PALETTE_ITEM_ID_PREFIX } from '@/lib/worktree-palette-create-action'
import {
  appendPaletteListEntries,
  type AgentPaletteItem,
  type PaletteListEntry
} from './worktree-jump-palette-model'
import { translate } from '@/i18n/i18n'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'

type WorktreeJumpPaletteAgentGroupsInput = Pick<WorktreeJumpPaletteLocalState, 'query' | 'filter'> &
  Pick<WorktreeJumpPaletteFilter, 'filterPredicate' | 'defaultHostId'> &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'> & { visible: boolean }

export type PaletteAgentGroupEntry = {
  key: PaletteAgentGroupKey
  total: number
  items: AgentPaletteItem[]
}

type AgentGroupSnapshot = {
  filter: WorktreeJumpPaletteLocalState['filter']
  groups: PaletteAgentGroupEntry[]
  /** Text shown if a row's thread leaves the pipeline while the palette is open. */
  frozenThreadByPaneKey: ReadonlyMap<string, AgentPaneThread>
  threads: AgentPaneThread[]
}

/** Header counts include rows the shared budget left out. */
export function paletteAgentGroupHeaderLabel(key: PaletteAgentGroupKey, total: number): string {
  switch (key) {
    case 'needs-you':
      return translate('worktreeJumpPalette.agents.needsYouHeader', 'Needs you · {{count}}', {
        count: total
      })
    case 'unread-results':
      return translate(
        'worktreeJumpPalette.agents.unreadResultsHeader',
        'Unread results · {{count}}',
        { count: total }
      )
    case 'working':
      return translate('worktreeJumpPalette.agents.workingHeader', 'Working · {{count}}', {
        count: total
      })
  }
}

export function appendPaletteAgentGroupEntries(
  entries: PaletteListEntry[],
  groups: readonly PaletteAgentGroupEntry[]
): void {
  for (const group of groups) {
    entries.push({
      id: `__header_agents_${group.key}__`,
      type: 'section-header',
      label: paletteAgentGroupHeaderLabel(group.key, group.total)
    })
    appendPaletteListEntries(entries, group.items)
  }
}

const NO_AGENT_GROUPS: PaletteAgentGroupEntry[] = []
const NO_THREADS: AgentPaneThread[] = []
const NO_SELECTED_PANE = (): void => {}

/** Agent groups shown above Recent on an empty query; layout is captured once per open or filter change. */
export function useWorktreeJumpPaletteAgentGroups({
  visible,
  hasQuery,
  query,
  filter,
  filterPredicate,
  defaultHostId
}: WorktreeJumpPaletteAgentGroupsInput) {
  const [snapshot, setSnapshot] = useState<AgentGroupSnapshot | null>(null)
  const liveThreadByPaneKey = usePaletteAgentThreads(
    snapshot?.threads ?? NO_THREADS,
    visible && !hasQuery && query.length === 0
  )
  useLayoutEffect(() => {
    if (!visible) {
      setSnapshot(null)
      return
    }
    if (hasQuery || query.length > 0 || snapshot?.filter === filter) {
      return
    }
    const storeData = useAppStore.getState()
    const allThreads = buildPaletteAgentThreads(storeData, getStructuredChatTabNames())
    const hiddenChildPaneKeys = collectHiddenChildAgentPaneKeys(allThreads)
    const tabIndexByWorktree = new Map<
      string,
      { tabIds: Set<string>; nativeChatTabIds: Set<string> }
    >()
    const candidates = allThreads.filter((thread) => {
      const { worktree } = thread
      if (
        hiddenChildPaneKeys.has(thread.paneKey) ||
        worktree.isArchived ||
        (filterPredicate && !filterPredicate.matchesWorktree(worktree))
      ) {
        return false
      }
      let tabIndex = tabIndexByWorktree.get(worktree.id)
      if (!tabIndex) {
        tabIndex = {
          tabIds: new Set((storeData.tabsByWorktree[worktree.id] ?? []).map((tab) => tab.id)),
          nativeChatTabIds: new Set<string>()
        }
        for (const tab of storeData.unifiedTabsByWorktree[worktree.id] ?? []) {
          tabIndex.tabIds.add(tab.id)
          if (tab.contentType === 'agent-session') {
            tabIndex.nativeChatTabIds.add(tab.id)
          }
        }
        tabIndexByWorktree.set(worktree.id, tabIndex)
      }
      // Remote tabs may be cold until activation revives them.
      return (
        tabIndex.tabIds.has(thread.tab.id) ||
        getWorktreeExecutionHostId(worktree, thread.repo ?? undefined, defaultHostId) !== 'local'
      )
    })
    const isNativeChat = (thread: AgentPaneThread): boolean =>
      tabIndexByWorktree.get(thread.worktree.id)?.nativeChatTabIds.has(thread.tab.id) ?? false
    const groups = buildPaletteAgentGroups(candidates, { now: Date.now(), isNativeChat })
    const threads = groups.flatMap((group) => group.threads)
    setSnapshot({
      filter,
      threads,
      groups: groups.map((group) => ({
        key: group.key,
        total: group.total,
        items: group.threads.map((thread) => ({
          id: `${AGENT_PALETTE_ITEM_ID_PREFIX}${thread.paneKey}`,
          type: 'agent',
          paneKey: thread.paneKey,
          groupKey: group.key
        }))
      })),
      frozenThreadByPaneKey: new Map(threads.map((thread) => [thread.paneKey, thread]))
    })
  }, [defaultHostId, filter, filterPredicate, hasQuery, query.length, snapshot, visible])

  const resolveAgentRowThread = useCallback(
    (paneKey: string): { thread: AgentPaneThread; available: boolean } | null => {
      const live = liveThreadByPaneKey.get(paneKey)
      if (live) {
        return { thread: live, available: true }
      }
      const frozen = snapshot?.frozenThreadByPaneKey.get(paneKey)
      return frozen ? { thread: frozen, available: false } : null
    },
    [liveThreadByPaneKey, snapshot]
  )

  const openAgentThread = useCallback(
    (paneKey: string): boolean => {
      const thread = liveThreadByPaneKey.get(paneKey)
      if (!thread) {
        return false
      }
      const storeData = useAppStore.getState()
      createActivityThreadActions({
        getMarkAllReadThreads: () => [],
        acknowledgeAgents: storeData.acknowledgeAgents,
        unacknowledgeAgents: storeData.unacknowledgeAgents,
        setSelectedPaneKey: NO_SELECTED_PANE
      }).selectThread(thread)
      return true
    },
    [liveThreadByPaneKey]
  )

  return {
    agentGroups: snapshot?.groups ?? NO_AGENT_GROUPS,
    resolveAgentRowThread,
    openAgentThread
  }
}

export type WorktreeJumpPaletteAgentGroups = ReturnType<typeof useWorktreeJumpPaletteAgentGroups>
