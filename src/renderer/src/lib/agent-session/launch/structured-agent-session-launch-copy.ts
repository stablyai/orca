import {
  agentCopyIdFromOptions,
  applyAgentCopy,
  findAgentCopy,
  withoutAgentCopyOption
} from '../../../../../shared/agent-launch/catalog/agent-copies'
import { structuredLaunchSeedOptions } from '../../../../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import { useAppStore } from '@/store/index'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type { StructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-intent'

/** A launch's options become the chat's explicit picks; a named agent copy among them goes into
 *  the create's own field, which the create's fingerprint covers, and seeds the chat with the
 *  copy's own model, options and permission. */
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
  const settings = useAppStore.getState().settings
  const copy = findAgentCopy(settings, agentCopy)
  // Paired hosts report their own seed; a fresh local chat reads the copy's settings here.
  if (settings && copy && intent.target.kind === 'local' && !intent.params.resumeFrom) {
    const seedOptions = structuredLaunchSeedOptions(applyAgentCopy(settings, copy), intent.agent)
    if (seedOptions) {
      intent.seedOptions = seedOptions
    } else {
      delete intent.seedOptions
    }
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
