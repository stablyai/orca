import type { AgentStatusIpcPayload } from '../../agent-status/contracts/agent-status-ipc-payload'
import type { TerminalTab } from '../../terminal-tab-types'

export type HookSessionBindingRendererFixture = {
  expectReturnedRenderer: (
    data: AgentStatusIpcPayload,
    id: string,
    agent: 'hermes' | 'antigravity',
    paneKey: string,
    worktreeId: string
  ) => TerminalTab
}
