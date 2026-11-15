import type { AgentStatusOrchestrationContext } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { TitleDerivedPaneForeground } from './title-derived-pane-agent-identity'

export type TitleDerivedAgentRowsInput = {
  tabs: TerminalTab[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  paneForegroundAgentByPaneKey?: Record<string, TitleDerivedPaneForeground>
  seenPaneKeys: Set<string>
  now: number
}
