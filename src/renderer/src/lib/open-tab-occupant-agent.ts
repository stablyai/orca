import type { RetainedAgentEntry } from '@/store/slices/agent-status/agent-status-contract'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { resolveTabAgentFromSignalSnapshot } from '../../../shared/tab-agent-from-signals'

export type OpenTabOccupantAgentInput = {
  tabId: string
  /** Use the resolved tab-strip label, not a terminal record that may retain stale Terminal N while unified OSC text is current. */
  title?: string
  defaultTitle?: string
  launchAgent?: TuiAgent
  layout?: TerminalLayoutSnapshot
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  paneForegroundAgentByPaneKey?: Record<string, PaneForegroundAgentEntry>
}

/** Reuse tab-strip identity with the same hook/sibling/sleeping/process evidence as useTabAgent. */
export function resolveOpenTabOccupantAgent({
  tabId,
  title,
  defaultTitle,
  launchAgent,
  layout,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  paneForegroundAgentByPaneKey
}: OpenTabOccupantAgentInput): TerminalAgent | null {
  const hookAgent = resolveFocusedTabAgent(agentStatusByPaneKey, layout, tabId)
  const siblingHookAgent = resolveSiblingTabAgent(agentStatusByPaneKey, layout, tabId)
  const focusedCompletedHookAgent =
    resolveFocusedCompletedTabAgent(agentStatusByPaneKey, layout, tabId) ??
    resolveFocusedRetainedTabAgent(retainedAgentsByPaneKey, layout, tabId)
  const siblingCompletedHookAgent =
    resolveSiblingCompletedTabAgent(agentStatusByPaneKey, layout, tabId) ??
    resolveSiblingRetainedTabAgent(retainedAgentsByPaneKey, layout, tabId)
  const focusedPaneKey = focusedPaneKeyFor(tabId, layout)
  const processAgent = focusedPaneKey
    ? (paneForegroundAgentByPaneKey?.[focusedPaneKey]?.agent ?? null)
    : null
  const sleepingSessionAgent = focusedPaneKey
    ? (sleepingAgentSessionsByPaneKey[focusedPaneKey]?.agent ?? null)
    : null
  return resolveTabAgentFromSignalSnapshot({
    title: title?.trim() || '',
    defaultTitle,
    hookAgent,
    siblingHookAgent,
    focusedCompletedHookAgent,
    siblingCompletedHookAgent,
    processAgent,
    sleepingSessionAgent,
    launchAgent
  })
}

function focusedPaneKeyFor(
  tabId: string,
  layout: TerminalLayoutSnapshot | undefined
): string | null {
  const activeLeafId = layout?.activeLeafId
  return activeLeafId && isTerminalLeafId(activeLeafId) ? makePaneKey(tabId, activeLeafId) : null
}
