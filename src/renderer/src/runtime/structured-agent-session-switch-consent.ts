import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { SWITCH_CONSENT_RUNTIME_CAPABILITY } from '../../../shared/structured-agent-cli-conversation-adoption'
import { structuredAgentSessionHostSupports } from './structured-agent-session-client'

/** Whether the host decides a switch's consent (refuses a replying agent unless consented). */
export function supportsSwitchConsent(target: RuntimeClientTarget): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, SWITCH_CONSENT_RUNTIME_CAPABILITY)
}
