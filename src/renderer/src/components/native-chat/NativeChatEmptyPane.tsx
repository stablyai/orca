import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import type { AgentType } from '../../../../shared/agent-status-types'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatInstallHero } from './NativeChatInstallHero'
import type { NativeChatInstallSlotState } from './NativeChatInstallSlot'

export function NativeChatEmptyPane(props: {
  slot: NativeChatInstallSlotState
  agent: AgentType
}): React.JSX.Element {
  const { slot, agent } = props
  return slot.kind === 'install' ? (
    <NativeChatInstallHero slot={slot} agentLabel={structuredAgentLabel(agent)} />
  ) : (
    <NativeChatEmptyState kind="empty" agent={agent} />
  )
}
