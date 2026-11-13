// CHAT-BANNERS B2: in a structured chat on Orca Cloud, a 401 from the agent ("not signed in") is the
// Orca-account sign-in, which the strip above renews. The generic card's advice (run the CLI's login,
// a Sign in button that opens a terminal on the host) points at the wrong fix there; this replaces it.
import { createContext, useContext, type ReactNode } from 'react'
import type React from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { agentSessionSetupFor } from '../../../../shared/agent-session/lifecycle/agent-session-setup-commands'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'

const CloudChatHostContext = createContext(false)

/** Marks a structured chat that runs on an Orca Cloud host. */
export function CloudChatHostProvider({
  target,
  children
}: {
  target: RuntimeClientTarget
  children: ReactNode
}): React.JSX.Element {
  const cloud = target.kind === 'environment' && isOrcaCloudEnvironmentId(target.environmentId)
  return <CloudChatHostContext.Provider value={cloud}>{children}</CloudChatHostContext.Provider>
}

export function useCloudChatHost(): boolean {
  return useContext(CloudChatHostContext)
}

/** The sign-in card's words on an Orca Cloud chat, or undefined to keep the card as it is. */
export function cloudChatSignInContent(
  cloudHost: boolean,
  failureKind: string | undefined,
  agentName: string | undefined,
  t: Translate = translate
): string | undefined {
  const agent = agentSessionSetupFor(agentName)?.agent
  if (!cloudHost || failureKind !== 'notSignedIn' || (agent !== 'claude' && agent !== 'codex')) {
    return undefined
  }
  return t(
    'orcaCloud.chatSignIn.renewAbove',
    'Your {{agent}} sign-in for Orca Cloud didn’t work. Renew it above, then send your message again.',
    { agent: HOST_AGENT_SIGN_IN_AGENT_NAME[agent] }
  )
}
