// CHAT-BANNERS: while a cloud pane's agent launch waits on its strip, the chat view's composer can't
// send to it; it is disabled and points at the strip above it, which is the one message.
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { agentName } from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import {
  cloudTabHoldKey,
  useCloudAgentHold,
  type CloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import {
  useAgentSignInGate,
  type AgentSignInGate
} from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'

export function cloudChatHoldHint(
  hold: Pick<CloudAgentHold, 'agent' | 'reason'> | null,
  gate: Pick<AgentSignInGate, 'agent' | 'environmentId'> | null,
  t: Translate
): string | undefined {
  if (hold) {
    const agent = agentName(hold.agent, t)
    return hold.reason === 'notSetUp'
      ? t('orcaCloud.chatHold.notSetUp', 'Set up {{agent}} above to start', { agent })
      : hold.reason === 'awaitingStart'
        ? t('orcaCloud.chatHold.awaitingStart', 'Start {{agent}} above', { agent })
        : t('orcaCloud.chatHold.expired', 'Renew {{agent}} sign-in above to start', { agent })
  }
  if (gate && isOrcaCloudEnvironmentId(gate.environmentId)) {
    return t('orcaCloud.chatHold.signIn', 'Sign in to {{agent}} above to start', {
      agent: agentName(gate.agent, t)
    })
  }
  return undefined
}

/** The composer's disabled hint while this pane's (or its tab's) cloud launch is held. */
export function useCloudChatHoldHint(paneKey: string, tabId: string): string | undefined {
  const t = useTranslate()
  const paneHold = useCloudAgentHold(paneKey)
  const tabHold = useCloudAgentHold(cloudTabHoldKey(tabId))
  const gate = useAgentSignInGate(paneKey)
  return cloudChatHoldHint(paneHold ?? tabHold, gate, t)
}
