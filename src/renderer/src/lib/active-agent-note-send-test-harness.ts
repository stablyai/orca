import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const PASTE_BEGIN = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

export type NoteSendAppState = {
  activeWorktreeId: string | null
  activeTabType: 'terminal' | 'editor'
  activeTabId: string | null
  activeTabIdByWorktree: Record<string, string | null>
  tabsByWorktree: Record<string, { id: string; launchAgent?: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  terminalLayoutsByTabId: Record<
    string,
    {
      activeLeafId: string | null
      root?: TerminalLayoutSnapshot['root']
      ptyIdsByLeafId?: Record<string, string | undefined>
    }
  >
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  settings: Record<string, unknown>
}

/** Renderer state for one worktree with a single focused terminal pane on `LEAF_ID`. */
export function createNoteSendAppState(): NoteSendAppState {
  return {
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: {},
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1' }]
    },
    ptyIdsByTabId: {
      'tab-1': ['pty-1']
    },
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {
      'tab-1': { activeLeafId: LEAF_ID, ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' } }
    },
    agentStatusByPaneKey: {},
    settings: {}
  }
}
