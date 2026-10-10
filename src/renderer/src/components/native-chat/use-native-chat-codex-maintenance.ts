import { useLayoutEffect, useRef } from 'react'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
import type { CodexMaintenanceTarget } from '@/lib/codex-maintenance-client'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { codexMaintenanceRecoveryNotice } from './codex-maintenance-recovery-notice'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

export function useNativeChatCodexMaintenance(input: {
  agent: string
  sessionId: string
  target: CodexMaintenanceTarget
  launch: ReturnType<typeof useNativeChatProvisionalLaunch>
  startFailures: readonly AgentSessionFailureFact[]
  queuedMessages: Pick<
    StructuredAgentSessionQueuedMessagesController,
    'cards' | 'steer' | 'queueResume'
  >
}) {
  const { launch, startFailures, sessionId, queuedMessages } = input
  const refused =
    launch.lifecycle === 'failed' &&
    launch.failure?.code === 'agent_session_operation_invalid' &&
    Boolean(launch.failure.details?.codexInstallation)
  const processless =
    refused &&
    launch.failure?.code === 'agent_session_operation_invalid' &&
    !launch.failure.details?.argumentProblem
  const historical = startFailures.some(
    (fact) =>
      fact.refusal?.code === 'agent_session_operation_invalid' &&
      fact.refusal.details?.codexInstallation
  )
  const maintenance = useCodexMaintenance(
    input.agent === 'codex' && (refused || historical) ? input.target : null
  )
  const ready = maintenance.installation?.status === 'ready'
  const recoveryKey = ready
    ? JSON.stringify([
        sessionId,
        maintenance.state?.evidence?.configurationId,
        maintenance.installation?.version
      ])
    : null
  const attempted = useRef<string | null>(null)
  const { retry } = launch
  const status = maintenance.installation?.status
  useLayoutEffect(() => {
    if (status === 'missing' || status === 'unsupported') {
      attempted.current = null
    }
    if (!processless || !recoveryKey || attempted.current === recoveryKey) {
      return
    }
    // A directory/account mismatch must not turn one ready check into a retry loop.
    attempted.current = recoveryKey
    retry()
  }, [recoveryKey, processless, retry, status])
  const updated = ready
    ? codexMaintenanceRecoveryNotice(refused ? retry : null, queuedMessages)
    : null
  return {
    ...maintenance,
    blocked: refused && maintenance.blocked,
    notice: maintenance.notice ?? updated
  }
}
