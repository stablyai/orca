import type { WorkInboxItem } from '../../../../shared/work-inbox'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'

export function openWorkInboxAgent(
  item: WorkInboxItem,
  target: RuntimeClientTarget
): Promise<void> {
  const orcaSessionId = parseOrcaSessionAddress(item.agentId)
  const sender = {
    party: {
      address: item.agentId,
      orcaSessionId,
      terminalHandle: orcaSessionId ? null : item.agentId
    },
    name: item.agentLabel
  }
  return openAgentMessageSender(
    { kind: 'agent', senders: [sender], orchestration: null },
    sender,
    item.worktreeId ?? '',
    target
  )
}
