import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import type { AppState } from '../../store/types'
import { titleHasAgentName } from '../../../../shared/agent-detection'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { useAppStore } from '../../store'

export function isAgentStatusForRecentlyClosedTab(
  store: Pick<AppState, 'recentlyClosedAgentStatusTabIds' | 'recentlyRetiredAgentStatusPaneKeys'>,
  paneKey: string,
  authorityRestartId?: string
): boolean {
  const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
  if (authorityRestartId && ownerPaneKey !== paneKey) {
    return true
  }
  const retirement = store.recentlyRetiredAgentStatusPaneKeys?.[ownerPaneKey]
  if (
    retirement !== undefined &&
    (typeof retirement !== 'string' || retirement !== authorityRestartId)
  ) {
    return true
  }
  const tabId = parsePaneKey(ownerPaneKey)?.tabId
  return tabId ? store.recentlyClosedAgentStatusTabIds[tabId] === true : false
}

/** Seed only previously seen host replays; a changed done row may represent completion while unreachable. */
export function isSeenHostReplay(
  data: Pick<
    AgentStatusIpcPayload,
    'isReplay' | 'stateStartedAt' | 'turnCompletedAt' | 'turnEndedAt'
  >,
  state: string,
  existing:
    | Pick<AppState['agentStatusByPaneKey'][string], 'state' | 'stateStartedAt' | 'turnEndedAt'>
    | undefined
): boolean {
  if (data.isReplay !== true) {
    return false
  }
  // Why: with no row there is no proof the turn was unseen, so keep seeding (no reload re-fires).
  if (existing === undefined) {
    return true
  }
  // Why: rows don't keep the stamp; the completion observer dedupes the ones it already handled.
  if (state === 'working' && Number.isFinite(data.turnCompletedAt)) {
    return false
  }
  // Why: the same done segment can hold a later turn end (a Stop re-entered while unreachable).
  return (
    state !== 'done' ||
    (existing.state === 'done' &&
      existing.stateStartedAt === data.stateStartedAt &&
      existing.turnEndedAt === data.turnEndedAt)
  )
}

export function hasRuntimeBackedWorktreeAttribution(data: AgentStatusIpcPayload): boolean {
  return (
    (typeof data.terminalHandle === 'string' && data.terminalHandle.length > 0) ||
    data.orchestration !== undefined
  )
}

export function tryMakePaneKey(tabId: string, leafId: string): string | null {
  try {
    return makePaneKey(tabId, leafId)
  } catch {
    return null
  }
}

export function applyResolvedAgentTerminalTitleToTab(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string,
  currentTabTitle: string | undefined,
  nextTitle: string | undefined
): void {
  if (
    !nextTitle ||
    !shouldApplyResolvedAgentTerminalTitleToTab(store, paneKey, currentTabTitle, nextTitle)
  ) {
    return
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return
  }
  // Why: hook completion can arrive while the pane transport is unmounted; keep the tab label synced to the resolved state title.
  store.updateTabTitle(parsed.tabId, nextTitle)
}

/** Compare the tab title this path writes, never the independently updated pane slot. Batched events compare against staged titles so later events overwrite the latest pending value. */
export function shouldApplyResolvedAgentTerminalTitleToTab(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string,
  currentTabTitle: string | undefined,
  nextTitle: string | undefined
): boolean {
  if (!nextTitle || nextTitle === currentTabTitle) {
    return false
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const layout = store.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && layout.activeLeafId && layout.activeLeafId !== parsed.leafId) {
    return false
  }
  return true
}

export function resolveHookPayloadAgentType(
  payload: ParsedAgentStatusPayload,
  terminalTitle: string | undefined
): ParsedAgentStatusPayload {
  if (
    payload.agentType !== 'claude' ||
    !terminalTitle ||
    !titleHasAgentName(terminalTitle, 'openclaude')
  ) {
    return payload
  }
  // OpenClaude uses Claude-compatible hooks; title evidence keeps it out of Claude-only handling.
  return { ...payload, agentType: 'openclaude' }
}

export { resolvePaneKey } from '../../lib/agent-status-pane-ownership'
