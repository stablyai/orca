import { findDuplicateIds } from '@/lib/unified-tab-host-ownership'
import type { AppState } from '@/store/types'
import { isAiVaultAgent, type AiVaultAgent } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { OriginalPaneState } from '../right-sidebar/ai-vault-original-pane'
import {
  buildAiVaultOriginalPaneIndex,
  type AiVaultOriginalPaneIndex
} from '../right-sidebar/ai-vault-original-pane-index'

export type PaletteTranscriptState = OriginalPaneState &
  Partial<Pick<AppState, 'unifiedTabsByWorktree'>>

type StructuredTranscriptTab = {
  agent: AiVaultAgent
  sessionId: string
  worktreeId: string
  tabId: string
}

export type PaletteTranscriptIndex = {
  executionHostId: ExecutionHostId
  terminalPanes: AiVaultOriginalPaneIndex
  structuredTabs: readonly StructuredTranscriptTab[]
  structuredTabsByAgent: ReadonlyMap<
    AiVaultAgent,
    ReadonlyMap<string, readonly StructuredTranscriptTab[]>
  >
}

export function buildPaletteTranscriptIndex(
  state: PaletteTranscriptState,
  executionHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): PaletteTranscriptIndex {
  const structuredTabs = paletteTranscriptStructuredTabs(state, executionHostId)
  const structuredTabsByAgent = new Map<AiVaultAgent, Map<string, StructuredTranscriptTab[]>>()
  for (const tab of structuredTabs) {
    let sessions = structuredTabsByAgent.get(tab.agent)
    if (!sessions) {
      sessions = new Map()
      structuredTabsByAgent.set(tab.agent, sessions)
    }
    const tabs = sessions.get(tab.sessionId)
    if (tabs) {
      tabs.push(tab)
    } else {
      sessions.set(tab.sessionId, [tab])
    }
  }
  return {
    executionHostId,
    terminalPanes: buildAiVaultOriginalPaneIndex(state),
    structuredTabs,
    structuredTabsByAgent
  }
}

/** Structured chats publish provider identity through their synthetic status pane. */
export function paletteTranscriptStructuredTabs(
  state: PaletteTranscriptState,
  executionHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): StructuredTranscriptTab[] {
  const targets: StructuredTranscriptTab[] = []
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree ?? {})) {
    const duplicates = findDuplicateIds(tabs)
    for (const tab of tabs) {
      if (
        tab.contentType !== 'agent-session' ||
        tab.worktreeId !== worktreeId ||
        duplicates.has(tab.id) ||
        (tab.executionHostId && tab.executionHostId !== executionHostId)
      ) {
        continue
      }
      const entry = state.agentStatusByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)]
      const sessionId = entry?.providerSession?.id
      if (
        !entry ||
        !isAiVaultAgent(entry.agentType) ||
        !sessionId ||
        sessionId.length > 512 ||
        (entry.worktreeId && entry.worktreeId !== worktreeId) ||
        (entry.tabId && entry.tabId !== tab.id)
      ) {
        continue
      }
      targets.push({ agent: entry.agentType, sessionId, worktreeId, tabId: tab.id })
    }
  }
  return targets
}
