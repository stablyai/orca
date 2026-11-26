// The toasts a host-admitted launch shows when its host declines or can't be reached.

import type { ChatAgentId } from '../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import { structuredChatUnavailableToast } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'

export function notifyExplicitChatFailure(
  agent: ChatAgentId,
  reason?: string,
  worktreeId?: string
): void {
  toast.error(
    translate(
      'auto.components.tab.bar.QuickLaunchButton.chatUnavailableAfterSelection',
      "Couldn't start a {{value0}} chat.",
      { value0: structuredAgentLabel(agent) }
    ),
    structuredChatUnavailableToast(reason, worktreeId)
  )
}

export function notifyHostDeclined(agent: ChatAgentId, explain = true): void {
  const agentLabel = structuredAgentLabel(agent)
  toast.info(
    translate(
      'components.native-chat.structuredSessionHostDeclined',
      'Opened {{value0}} in a terminal',
      { value0: agentLabel }
    ),
    explain
      ? {
          description: translate(
            'components.native-chat.structuredSessionHostDeclinedDescription',
            "This workspace can't run a {{value0}} chat.",
            { value0: agentLabel }
          )
        }
      : undefined
  )
}

export function notifyHostUnreachable(agent: ChatAgentId, executionHostId: ExecutionHostId): void {
  const hostLabel = selectExecutionHostDisplayLabel(useAppStore.getState(), executionHostId)
  toast.error(
    translate(
      'components.native-chat.structuredSessionHostUnreachable',
      'Could not reach {{value0}}',
      {
        value0: hostLabel
      }
    ),
    {
      description: translate(
        'components.native-chat.structuredSessionHostUnreachableDescription',
        'Orca did not open a {{value0}} chat. Check the connection to the server and try again.',
        { value0: structuredAgentLabel(agent) }
      )
    }
  )
}
