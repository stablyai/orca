import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { SWITCH_CONSENT_RUNTIME_CAPABILITY } from '../../../shared/structured-agent-cli-conversation-adoption'
import { readStructuredAgentSessionHostSupport } from './structured-agent-session-host-support'

/** Whether the host decides a switch's consent (refuses a replying agent unless consented);
 *  rejects when the host couldn't be asked. */
export function supportsSwitchConsent(target: RuntimeClientTarget): Promise<boolean> {
  return readStructuredAgentSessionHostSupport(target, SWITCH_CONSENT_RUNTIME_CAPABILITY)
}
