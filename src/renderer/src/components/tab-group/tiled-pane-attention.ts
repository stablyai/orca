import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AppState } from '../../store/types'
import { cn } from '@/lib/utils'
import {
  agentStatusTabIdForTab,
  selectAgentsTab,
  selectAgentTabs
} from '../../store/slices/tabs/agent-card-tabs'
import { agentDotStateFrameToneClassName } from '../AgentStateDot'
import { dashboardBucketForDotState } from '../dashboard/dashboard-card-bucket'
import { findTabAgentEntry } from '../native-chat/native-chat-tab-agent-entry'
import { resolveNativeChatHookState } from '../native-chat/use-native-chat-hook-status'

/** States that earn a tiled-pane frame tint: the dashboard's attention/done buckets. */
export type TiledPaneFrameState = Exclude<AgentStatusState, 'working'>
/** Every tone a tiled pane's frame can render; 'plain' is tiled but untinted. */
export type TiledPaneFrameTone = 'plain' | TiledPaneFrameState

const EMPTY_TILED_PANE_FRAME_STATES: ReadonlyMap<string, TiledPaneFrameState> = new Map()

/** True when the global experiment is on. worktreeId is unused: V3 has no per-worktree flag. */
export function isTiledAgentsModeActive(
  state: Pick<AppState, 'settings'>,
  _worktreeId: string
): boolean {
  return state.settings?.experimentalTiledAgents === true
}

/** The maximized group id when the experiment is on, else undefined so a disabled
 *  experiment can never leave a stale flex override applied. */
export function resolveTiledMaximizedGroupId(
  state: Pick<AppState, 'settings' | 'maximizedGroupIdByWorktree'>,
  worktreeId: string
): string | undefined {
  return isTiledAgentsModeActive(state, worktreeId)
    ? state.maximizedGroupIdByWorktree[worktreeId]
    : undefined
}

/** Caller (`selectTiledPaneAttentionKey`) already gates on `isTiledAgentsModeActive` before
 *  reaching here, so the off path never allocates or scans groups/tabs. */
function resolveTiledPaneFrameStates(
  state: Pick<
    AppState,
    | 'settings'
    | 'groupsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'tabsByWorktree'
    | 'agentStatusByPaneKey'
    | 'agentStatusEpoch'
  >,
  worktreeId: string
): { groupId: string; frameState: TiledPaneFrameState }[] {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  // Why a set, not a per-group contentType check: a terminal-route agent's identity lives on the
  // sibling TerminalTab, not on the unified tab itself (see selectAgentTabs).
  const agentTabIds = new Set(
    selectAgentTabs(tabs, state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  )
  const results: { groupId: string; frameState: TiledPaneFrameState }[] = []
  for (const group of groups) {
    const activeTab = tabs.find((tab) => tab.id === group.activeTabId)
    if (!activeTab || !agentTabIds.has(activeTab.id)) {
      continue
    }
    const entry = findTabAgentEntry(state.agentStatusByPaneKey, agentStatusTabIdForTab(activeTab))
    const resolved = resolveNativeChatHookState(entry)
    if (resolved === null || resolved === 'working') {
      continue
    }
    // Why: bucket gates inclusion (working/idle stay plain per 4.9); the raw
    // state (not the bucket) still picks the color, so blocked/waiting differ.
    const bucket = dashboardBucketForDotState(resolved)
    if (bucket !== 'attention' && bucket !== 'done') {
      continue
    }
    results.push({ groupId: group.id, frameState: resolved })
  }
  return results
}

/** Sorted, comma-joined `groupId:state` pairs for tiled panes whose agent's
 *  dashboard bucket is attention or done. Empty string when none, so the
 *  selector output is a stable primitive: a fresh Map/Set on every
 *  agent-status frame would repaint the whole split tree, see
 *  `check:zustand-selector-fanout`. */
export function selectTiledPaneAttentionKey(
  state: Pick<
    AppState,
    | 'settings'
    | 'groupsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'tabsByWorktree'
    | 'agentStatusByPaneKey'
    | 'agentStatusEpoch'
  >,
  worktreeId: string
): string {
  // Why first: the off path must cost only the gate read, never a groups/tabs scan, since
  // this selector runs on every store publication for every mounted worktree surface.
  if (!isTiledAgentsModeActive(state, worktreeId)) {
    return ''
  }
  return resolveTiledPaneFrameStates(state, worktreeId)
    .map(({ groupId, frameState }) => `${groupId}:${frameState}`)
    .sort()
    .join(',')
}

/** '' when the experiment is off, else `1|${agentsTabId}|${cardGroupIds}|${orderedAgentTabIds}`.
 *  Drives useAgentCardsReconciler: any change to the experiment flag, the Agents tab's
 *  existence, the card group registry, or the ordered agent tab ids re-runs syncAgentCards,
 *  so the reconciler self-heals after the Agents tab is dropped or a card group is closed.
 *  Gated on the experiment alone so a setting flip still changes the key and lets the
 *  reconciler's deactivate branch run. */
export function selectTiledAgentsReconcileKey(
  state: Pick<
    AppState,
    'settings' | 'unifiedTabsByWorktree' | 'tabsByWorktree' | 'agentCardGroupIdsByWorktree'
  >,
  worktreeId: string
): string {
  if (state.settings?.experimentalTiledAgents !== true) {
    return ''
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const agentTabs = selectAgentTabs(tabs, state.tabsByWorktree[worktreeId] ?? [])
  const agentsTabId = selectAgentsTab(tabs)?.id ?? ''
  const cardGroupIds = (state.agentCardGroupIdsByWorktree[worktreeId] ?? []).join(',')
  return `1|${agentsTabId}|${cardGroupIds}|${agentTabs.map((tab) => tab.id).join(',')}`
}

/** Parses `selectTiledPaneAttentionKey`'s output back into a lookup map. Pure,
 *  so the renderer memoizes off the primitive key instead of minting a fresh
 *  Map identity on every unrelated store write. */
export function parseTiledPaneAttentionKey(key: string): ReadonlyMap<string, TiledPaneFrameState> {
  if (key.length === 0) {
    return EMPTY_TILED_PANE_FRAME_STATES
  }
  const map = new Map<string, TiledPaneFrameState>()
  for (const pair of key.split(',')) {
    const [groupId, frameState] = pair.split(':')
    if (
      groupId &&
      (frameState === 'blocked' || frameState === 'waiting' || frameState === 'done')
    ) {
      map.set(groupId, frameState)
    }
  }
  return map
}

/** Card-style frame classes for a tiled pane: geometry copied verbatim from
 *  AgentKanbanCard's outer container (border width/opacity, radius, hover
 *  strengthening), colored per AgentStateDot's own palette for the
 *  attention/done buckets. Empty string when the pane isn't tiled at all. */
export function tiledPaneFrameClassName(tone: TiledPaneFrameTone | undefined): string {
  if (tone === undefined) {
    return ''
  }
  if (tone === 'plain') {
    return 'rounded-lg border border-border/60 hover:border-border'
  }
  // Why cn(), not a template literal: the tone classes come from AgentStateDot's canonical
  // mapping (the one palette source), passed through as a discrete argument, never interpolated.
  return cn('rounded-lg border', agentDotStateFrameToneClassName(tone))
}
