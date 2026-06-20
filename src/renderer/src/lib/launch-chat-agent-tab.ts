import { useAppStore } from '@/store'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'

export type ChatAgentLaunchResult = {
  tabId: string
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
}

/**
 * Launch a chat-mode agent (jcode, M1) into a 'chat' content-type tab.
 *
 * Why: chat-mode agents are not hosted in an xterm PTY. They run headless via
 * `jcode run --ndjson` inside ChatPane, which spawns its own child process per
 * turn. So instead of building a shell startup command and a terminal tab, we
 * create a unified tab with contentType 'chat' and flip the visible surface to
 * editor (chat maps to the editor visible-tab type). This is the wiring that
 * makes TUI_AGENT_CONFIG[agent].renderMode === 'chat' actually reach
 * TabGroupPanel's chat render branch — without it the chat view is unreachable
 * and the agent falls back to a bare terminal.
 */
export function launchChatAgentTab(args: {
  agent: TuiAgent
  worktreeId: string
  groupId?: string
  quickCommandLabel?: string | null
}): ChatAgentLaunchResult {
  const { agent, worktreeId, groupId, quickCommandLabel } = args
  const store = useAppStore.getState()
  const chatTab = store.createUnifiedTab(worktreeId, 'chat', {
    ...(groupId ? { targetGroupId: groupId } : {}),
    label: 'jcode',
    ...(quickCommandLabel !== undefined ? { quickCommandLabel } : {}),
    activate: true
  })
  // Why: 'chat' maps to the 'editor' visible-tab type (see toVisibleTabType),
  // so the worktree must show the editor surface or the new chat tab stays
  // hidden behind whatever terminal/browser surface was active.
  store.setActiveTabType('editor')
  return {
    tabId: chatTab.id,
    // Why: chat mode has no shell startup command; surface a minimal plan so
    // callers keep the non-null result contract (QuickLaunch reads tabId).
    startupPlan: {
      agent,
      launchCommand: '',
      expectedProcess: TUI_AGENT_CONFIG[agent].expectedProcess,
      followupPrompt: null
    },
    pasteDraftAfterLaunch: false
  }
}
