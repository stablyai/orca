import {
  agentCopyIdFromOptions,
  withoutAgentCopyOption
} from '../../../../../shared/agent-launch/catalog/agent-copies'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type { StructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-intent'

/** A launch's options become the chat's explicit picks; a named agent copy among them goes into
 *  the create's own field, which the create's fingerprint covers. */
export function applyStructuredLaunchOptions(
  intent: StructuredAgentSessionLaunchIntent,
  launchOptions: Readonly<Record<string, string>> | undefined
): void {
  const explicit = withoutAgentCopyOption(launchOptions)
  intent.explicitLaunchOptions = explicit ? { ...explicit } : undefined
  const agentCopy = agentCopyIdFromOptions(launchOptions)
  if (!agentCopy) {
    return
  }
  const params = { ...intent.params, agentCopy }
  intent.params = {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: intent.sessionId,
        ...params
      })
    }
  }
}
