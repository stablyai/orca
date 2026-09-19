import { useMemo, useSyncExternalStore } from 'react'
import type { AppState } from '../../store/types'
import { useAppStore } from '../../store'
import { selectAgentsTab } from '../../store/slices/tabs/agent-card-tabs'

const EMPTY_IDS: ReadonlySet<string> = new Set()

const hiddenByWorktree = new Map<string, Set<string>>()
let hiddenEpoch = 0
const hiddenListeners = new Set<() => void>()

function emitHiddenChange(): void {
  hiddenEpoch += 1
  for (const listener of hiddenListeners) {
    listener()
  }
}

/** IntersectionObserver reports: hidden cards must not paint outside the grid rect (F2). */
export function reportAgentCardHidden(worktreeId: string, groupId: string, hidden: boolean): void {
  const ids = hiddenByWorktree.get(worktreeId)
  if (hidden === (ids?.has(groupId) ?? false)) {
    return
  }
  if (!hidden && ids) {
    ids.delete(groupId)
    // Why: every card reports visible on unmount, so without this each worktree that ever showed
    // cards would keep an empty Set for the rest of the session.
    if (ids.size === 0) {
      hiddenByWorktree.delete(worktreeId)
    }
  } else if (hidden) {
    if (ids) {
      ids.add(groupId)
    } else {
      hiddenByWorktree.set(worktreeId, new Set([groupId]))
    }
  }
  emitHiddenChange()
}

/** Worktrees with at least one hidden card; empty entries are dropped, so this is exact. */
export function trackedAgentCardHiddenWorktreeIdsForTests(): readonly string[] {
  return [...hiddenByWorktree.keys()].sort()
}

export function subscribeAgentCardHidden(onStoreChange: () => void): () => void {
  hiddenListeners.add(onStoreChange)
  return () => {
    hiddenListeners.delete(onStoreChange)
  }
}

export function getAgentCardHiddenEpoch(): number {
  return hiddenEpoch
}

export function hiddenAgentCardGroupIds(worktreeId: string): readonly string[] {
  return [...(hiddenByWorktree.get(worktreeId) ?? [])].sort()
}

export function resetAgentCardHiddenForTests(): void {
  hiddenByWorktree.clear()
  emitHiddenChange()
}

export type AgentCardPaneVisibility = {
  gridOnScreen: boolean
  cardGroupIds: ReadonlySet<string>
  hiddenCardGroupIds: ReadonlySet<string>
}

const EMPTY_VISIBILITY: AgentCardPaneVisibility = {
  gridOnScreen: false,
  cardGroupIds: EMPTY_IDS,
  hiddenCardGroupIds: EMPTY_IDS
}

function parseIdList(part: string): ReadonlySet<string> {
  if (part.length === 0) {
    return EMPTY_IDS
  }
  return new Set(part.split(',').filter((id) => id.length > 0))
}

/** '' when the experiment is off or this worktree has no cards, else
 *  `${gridOnScreen ? '1' : '0'}|${hiddenCardGroupIds.join(',')}|${cardGroupIds.join(',')}`. */
export function selectAgentCardPaneVisibilityKey(
  state: Pick<
    AppState,
    'settings' | 'agentCardGroupIdsByWorktree' | 'unifiedTabsByWorktree' | 'groupsByWorktree'
  >,
  worktreeId: string
): string {
  if (state.settings?.experimentalTiledAgents !== true) {
    return ''
  }
  const cardGroupIds = state.agentCardGroupIdsByWorktree[worktreeId] ?? []
  if (cardGroupIds.length === 0) {
    return ''
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const agentsTab = selectAgentsTab(tabs)
  const homeGroup = agentsTab
    ? (state.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === agentsTab.groupId)
    : undefined
  // Why: undefined === undefined is true, so require agentsTab to exist first, or a
  // missing Agents tab (B1/B3 dead-end state) reads as the grid being on screen.
  const gridOnScreen = agentsTab !== undefined && homeGroup?.activeTabId === agentsTab.id
  const hidden = hiddenAgentCardGroupIds(worktreeId).join(',')
  return `${gridOnScreen ? '1' : '0'}|${hidden}|${cardGroupIds.join(',')}`
}

export function parseAgentCardPaneVisibility(key: string): AgentCardPaneVisibility {
  if (key.length === 0) {
    return EMPTY_VISIBILITY
  }
  const first = key.indexOf('|')
  if (first === -1) {
    return EMPTY_VISIBILITY
  }
  const second = key.indexOf('|', first + 1)
  const gridPart = key.slice(0, first)
  const hiddenPart = second === -1 ? key.slice(first + 1) : key.slice(first + 1, second)
  const cardPart = second === -1 ? '' : key.slice(second + 1)
  return {
    gridOnScreen: gridPart === '1',
    hiddenCardGroupIds: parseIdList(hiddenPart),
    cardGroupIds: parseIdList(cardPart)
  }
}

export function isAgentCardPanePresentable(
  groupId: string | undefined,
  visibility: AgentCardPaneVisibility
): boolean {
  if (!groupId || !visibility.cardGroupIds.has(groupId)) {
    return true
  }
  return visibility.gridOnScreen && !visibility.hiddenCardGroupIds.has(groupId)
}

/** Store key plus hidden-registry epoch so scroll crossings re-render overlays. */
export function useAgentCardPaneVisibility(worktreeId: string): AgentCardPaneVisibility {
  const storeKey = useAppStore((state) => selectAgentCardPaneVisibilityKey(state, worktreeId))
  const epoch = useSyncExternalStore(subscribeAgentCardHidden, getAgentCardHiddenEpoch)
  const revision = `${storeKey}#${epoch}`
  return useMemo(() => {
    const key = revision.slice(0, revision.lastIndexOf('#'))
    if (key.length === 0) {
      return parseAgentCardPaneVisibility('')
    }
    return parseAgentCardPaneVisibility(
      selectAgentCardPaneVisibilityKey(useAppStore.getState(), worktreeId)
    )
  }, [revision, worktreeId])
}
