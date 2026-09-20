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

/**
 * `currentTabTitle` must be the TAB record's title, not the pane's layout slot. This path writes
 * `tab.title` and nothing else, so comparing against `titlesByLeafId` — which only a mounted pane
 * updates — skipped the write whenever the two slots had diverged, stranding a self-authored
 * "<Agent> - action required" label on the tab after the agent had already reported done.
 *
 * Inside a batch, pass the staged `tabTitlesByTabId` value when one exists: the batch flushes tab
 * titles at the end, so an earlier event's staged write is what a later event actually overwrites.
 */
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
  // Why: OpenClaude emits Claude-compatible hooks; the title is the last renderer signal to keep it out of Claude-only status paths.
  return { ...payload, agentType: 'openclaude' }
}

export { resolvePaneKey, resolveWorktreeConnection } from '../../lib/agent-status-pane-ownership'
