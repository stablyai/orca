import {
  aiVaultResumeUnsupportedMessage,
  resolveAiVaultSessionLaunchTarget
} from './ai-vault-session-launch-target'
import { toast } from 'sonner'
import { describeAiVaultResumeFailure } from '@/lib/ai-vault-resume-refusal'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'

export function notifyAiVaultSessionQueued(agent: AiVaultAgent): void {
  toast.success(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.agentSessionQueued',
      '{{value0}} session queued',
      { value0: agentLabel(agent) }
    )
  )
}

export function notifyAiVaultSessionPreparationFailure(
  error: unknown,
  agent: AiVaultAgent,
  describeFailure: (message: string) => string = (message) => message
): void {
  const described = error instanceof Error ? new Error(describeFailure(error.message)) : error
  toast.error(describeAiVaultResumeFailure(described, agent))
}

export function resolveAiVaultSessionLaunchTargetOrNotify(
  args: Parameters<typeof resolveAiVaultSessionLaunchTarget>[0]
): Extract<ReturnType<typeof resolveAiVaultSessionLaunchTarget>, { status: 'ready' }> | null {
  const target = resolveAiVaultSessionLaunchTarget(args)
  if (target.status === 'missing') {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
        'Open a workspace before resuming a session.'
      )
    )
    return null
  }
  if (target.status === 'unsupported') {
    toast.error(aiVaultResumeUnsupportedMessage(target.targetStatus))
    return null
  }
  return target
}
