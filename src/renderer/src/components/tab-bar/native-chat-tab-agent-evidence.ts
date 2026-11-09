import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveExplicitTerminalTitleAgentType } from '../../../../shared/agent-status/title/terminal-title-agent-type'

/** Resolve durable tab metadata used before a live pane status arrives. */
export function resolveNativeChatTabAgentEvidence(
  tab: Pick<TerminalTab, 'title' | 'aiVaultTitle'>,
  unifiedTab?: Pick<Tab, 'label' | 'aiVaultTitle'>
): TuiAgent | null {
  const agent =
    resolveExplicitTerminalTitleAgentType(unifiedTab?.label ?? '') ??
    resolveExplicitTerminalTitleAgentType(tab.title) ??
    unifiedTab?.aiVaultTitle?.agent ??
    tab.aiVaultTitle?.agent ??
    null
  return isTuiAgent(agent) ? agent : null
}
