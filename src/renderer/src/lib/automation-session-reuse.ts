import type { AutomationRun } from '../../../shared/automations-types'
import { findReusableAutomationRun } from '../../../shared/automation-session-reuse'
import type { TuiAgent } from '../../../shared/tui-agent'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { isNativeChatDefaultFor } from '../../../shared/structured-native-chat-launch-route'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import type { AppState } from '@/store/types'

export type ReusableAutomationSession =
  | {
      kind?: 'terminal'
      tabId: string
      ptyId: string
      paneKey: string
    }
  | {
      kind: 'structured'
      tabId: string
      chatSessionId: string
      paneKey: string
    }

export function findReusableAutomationSession(args: {
  automationId: string
  agentId: TuiAgent
  worktreeId: string
  currentRunId: string
  runs: AutomationRun[]
  state: Pick<
    AppState,
    'agentStatusByPaneKey' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'unifiedTabsByWorktree'
  > &
    Partial<Pick<AppState, 'settings'>>
}): ReusableAutomationSession | null {
  const { state, ...selection } = args
  const unifiedTabs = state.unifiedTabsByWorktree[args.worktreeId] ?? []
  const terminalTabIds = new Set(
    unifiedTabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
  )
  const allowStructuredReuse =
    state.settings === undefined || isNativeChatDefaultFor(state.settings, args.agentId)
  const structuredTabsBySessionId = new Map(
    allowStructuredReuse
      ? unifiedTabs
          .filter((tab) => tab.contentType === 'agent-session')
          .map((tab) => [tab.entityId, tab] as const)
      : []
  )
  return findReusableAutomationRun<ReusableAutomationSession>({
    ...selection,
    agentStatusForPane: (paneKey) => state.agentStatusByPaneKey[paneKey],
    liveSession: (run) => {
      const parsed = parsePaneKey(run.terminalPaneKey)
      if (
        !parsed ||
        !terminalTabIds.has(parsed.tabId) ||
        !isRunPtyLiveInPane(state, parsed.tabId, parsed.leafId, run.terminalPtyId)
      ) {
        return null
      }
      return { tabId: parsed.tabId, ptyId: run.terminalPtyId, paneKey: run.terminalPaneKey }
    },
    structuredStatusForSession: (chatSessionId, run) => {
      const tab = structuredTabsBySessionId.get(chatSessionId)
      const tabId = tab?.id ?? run.terminalSessionId ?? structuredAgentSessionTabId(chatSessionId)
      const paneKey = run.terminalPaneKey ?? structuredAgentSessionPaneKey(tabId, chatSessionId)
      return state.agentStatusByPaneKey[paneKey]
    },
    liveStructuredSession: (run) => {
      const tab = structuredTabsBySessionId.get(run.chatSessionId)
      if (!tab) {
        return null
      }
      const paneKey =
        run.terminalPaneKey ?? structuredAgentSessionPaneKey(tab.id, run.chatSessionId)
      return {
        kind: 'structured',
        tabId: tab.id,
        chatSessionId: run.chatSessionId,
        paneKey
      }
    }
  })
}

function isRunPtyLiveInPane(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  tabId: string,
  leafId: string,
  ptyId: string
): boolean {
  if (!state.ptyIdsByTabId[tabId]?.includes(ptyId)) {
    return false
  }
  const layoutPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  return layoutPtyId === undefined || layoutPtyId === ptyId
}
