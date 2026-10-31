import { AgentMessageAvatar } from '@/components/AgentMessageAvatar'
import { mapAgentStatusStateToVisualStatus } from '@/lib/agent-status'
import { isAgentStatusState } from '../../../../shared/agent-status-types'
import { isOrcaSessionId, formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export function CrewAgentAvatar({
  row,
  target,
  tooltip = false
}: {
  row: OrchestrationCrewRow
  target: RuntimeClientTarget
  tooltip?: boolean
}) {
  const location = row.hostLabel ? undefined : row.openTarget
  let sender: AgentMessageSender | undefined
  if (location?.kind === 'chat' && isOrcaSessionId(location.sessionId)) {
    sender = {
      name: row.label,
      party: {
        address: formatOrcaSessionAddress(location.sessionId),
        orcaSessionId: location.sessionId,
        terminalHandle: null
      }
    }
  } else if (location?.kind === 'terminal') {
    sender = {
      name: row.label,
      party: { address: location.handle, terminalHandle: location.handle, orcaSessionId: null }
    }
  }
  return (
    <AgentMessageAvatar
      sender={sender}
      worktreeId={location?.kind === 'chat' ? location.worktreeId : null}
      target={target}
      fallback={{
        agentType: row.agentKind,
        dot: isAgentStatusState(row.status)
          ? mapAgentStatusStateToVisualStatus(row.status) === 'permission'
            ? 'permission'
            : row.status
          : 'idle'
      }}
      pendingQuestion={Boolean(row.pendingQuestion)}
      tooltip={tooltip}
      hostLabel={row.hostLabel}
    />
  )
}
