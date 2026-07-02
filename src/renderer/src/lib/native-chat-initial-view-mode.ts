import type { AgentType } from '../../../shared/agent-status-types'
import type { GlobalSettings, Tab, TuiAgent } from '../../../shared/types'

/**
 * Decide the initial `viewMode` for a newly launched agent tab from the
 * opt-in `openAgentTabsInChatByDefault` setting.
 *
 * Returns `'chat'` only when the setting is explicitly on; otherwise returns
 * `undefined` so the tab keeps the implicit default (`'terminal'`) and stays
 * backward-compatible with tabs persisted before the setting existed.
 */
export function decideInitialAgentTabViewMode(
  agent: TuiAgent | AgentType | null | undefined,
  experimentalNativeChat: boolean | undefined,
  openAgentTabsInChatByDefault: boolean | undefined
): Tab['viewMode'] {
  // Why: CodeWhale is terminal-only in this PR; native chat cannot read its JSON
  // session files, so default-chat tab creation must not select chat view.
  return agent !== 'codewhale' &&
    experimentalNativeChat === true &&
    openAgentTabsInChatByDefault === true
    ? 'chat'
    : undefined
}

export function initialAgentTabViewModeProps(
  settings: Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'> | null,
  agent: TuiAgent | AgentType | null | undefined
): { viewMode?: Tab['viewMode'] } {
  const viewMode = decideInitialAgentTabViewMode(
    agent,
    settings?.experimentalNativeChat,
    settings?.openAgentTabsInChatByDefault
  )
  return viewMode ? { viewMode } : {}
}
