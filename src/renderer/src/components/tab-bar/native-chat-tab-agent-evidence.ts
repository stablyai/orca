import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'

/** Resolve durable tab metadata used before a live pane status arrives. */
export function resolveNativeChatTabAgentEvidence(
  tab: Pick<TerminalTab, 'title' | 'aiVaultTitle'>,
  unifiedTab?: Pick<Tab, 'label' | 'aiVaultTitle'>
): TuiAgent | null {
  const agent =
    resolveCommittedTitleAgentType(unifiedTab?.label ?? '') ??
    resolveCommittedTitleAgentType(tab.title) ??
    unifiedTab?.aiVaultTitle?.agent ??
    tab.aiVaultTitle?.agent ??
    null
  return isTuiAgent(agent) ? agent : null
}
