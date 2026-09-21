import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'

/** Resolve durable tab metadata used before a live pane status arrives. */
export function resolveNativeChatTabAgentEvidence(
  tab: Pick<TerminalTab, 'title' | 'aiVaultTitle'>,
  unifiedTab?: Pick<Tab, 'label' | 'aiVaultTitle'>
): TuiAgent | null {
  return (
    resolveCommittedTitleAgentType(unifiedTab?.label ?? '') ??
    resolveCommittedTitleAgentType(tab.title) ??
    unifiedTab?.aiVaultTitle?.agent ??
    tab.aiVaultTitle?.agent ??
    null
  )
}
