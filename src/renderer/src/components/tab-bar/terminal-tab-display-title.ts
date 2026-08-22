import { stripLeadingAgentTitleDecoration } from '../../../../shared/agent-title-decoration'
import { resolveNativeChatSessionTitle } from '../../../../shared/native-chat-session-title'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function resolveTerminalTabDisplayTitle(
  tab: TerminalTab,
  agent: TuiAgent | null,
  isChatView: boolean
): string {
  if (tab.customTitle) {
    return tab.customTitle
  }
  if (isChatView && agent) {
    return resolveNativeChatSessionTitle(tab, agent, false)
  }
  return agent ? stripLeadingAgentTitleDecoration(tab.title) : tab.title
}
