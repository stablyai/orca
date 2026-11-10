import { agentTypeToIconAgent } from '../../../shared/agent-status/presentation/agent-type-icon-agent'
import { paneAgentRecordIdentity } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-foreground-agent'
import type { OwnedPaneAgentRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status/contracts/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/agent-status/identity/terminal-agent'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
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
  sleepingAgentSessionsByPaneKey: Record<string, OwnedPaneAgentRecord>
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
  sleepingAgentSessionsByPaneKey,
  paneForegroundAgentByPaneKey
}: OpenTabOccupantAgentInput): TerminalAgent | null {
  const hookAgent = resolveFocusedTabAgent(agentStatusByPaneKey, layout, tabId)
  const siblingHookAgent = resolveSiblingTabAgent(agentStatusByPaneKey, layout, tabId)
  const focusedCompletedHookAgent = resolveFocusedCompletedTabAgent(
    agentStatusByPaneKey,
    layout,
    tabId
  )
  const siblingCompletedHookAgent = resolveSiblingCompletedTabAgent(
    agentStatusByPaneKey,
    layout,
    tabId
  )
  const focusedPaneKey = focusedPaneKeyFor(tabId, layout)
  const processAgent = focusedPaneKey
    ? (paneForegroundAgentByPaneKey?.[focusedPaneKey]?.agent ?? null)
    : null
  const sleepingSessionAgent = focusedPaneKey
    ? (agentTypeToIconAgent(
        paneAgentRecordIdentity(sleepingAgentSessionsByPaneKey[focusedPaneKey]).agent
      ) ?? null)
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
