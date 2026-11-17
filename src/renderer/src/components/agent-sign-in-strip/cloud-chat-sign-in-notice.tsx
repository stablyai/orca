// In a structured chat on Orca Cloud, a 401 from the agent ("not signed in") is the
// Orca-account sign-in, which the strip above renews. The generic card's advice (run the CLI's login,
// a Sign in button that opens a terminal on the host) points at the wrong fix there; this replaces it.
import { createContext, useContext, type ReactNode } from 'react'
import type React from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { agentSessionSetupFor } from '../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import { useTranslate } from '@/i18n/use-translate'
import { orcaCloudAgentCoverageFromAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'

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

/**
 * The sign-in card's words on an Orca Cloud chat, or undefined to keep the card as it is. An agent
 * signed in inside the workspace keeps the generic card (its Sign in opens a terminal on the host);
 * the caller words that one with useCloudChatSignInInside.
 */
export function cloudChatSignInContent(
  cloudHost: boolean,
  failureKind: string | undefined,
  agentName: string | undefined,
  t: Translate = translate,
  inside: CloudChatSignInInside | null = null
): string | undefined {
  const agent = agentSessionSetupFor(agentName)?.agent
  if (
    inside ||
    !cloudHost ||
    failureKind !== 'notSignedIn' ||
    (agent !== 'claude' && agent !== 'codex')
  ) {
    return undefined
  }
  return t(
    'orcaCloud.chatSignIn.renewAbove',
    'Your {{agent}} sign-in for Orca Cloud didn’t work. Renew it above, then send your message again.',
    { agent: HOST_AGENT_SIGN_IN_AGENT_NAME[agent] }
  )
}

/** What a "not signed in" chat says when its agent signs in inside the workspace, and its button. */
type CloudChatSignInInside = { text: string; actionLabel: string }

function cloudChatSignInInsideWords(
  agent: 'claude' | 'codex',
  t: Translate = translate
): CloudChatSignInInside {
  return {
    text: t('orcaCloud.chatSignIn.inside', '{{agent}} needs you to sign in inside this workspace', {
      agent: HOST_AGENT_SIGN_IN_AGENT_NAME[agent]
    }),
    actionLabel: t('orcaCloud.chatSignIn.openTerminal', 'Open terminal to sign in')
  }
}

/**
 * A structured chat on Orca Cloud whose Claude or Codex the person signs in inside each workspace:
 * nothing of Orca's signs it in, so "not signed in" means the agent's own login, run in a terminal on
 * the workspace (the chat's Sign in button already opens one with the agent's login command).
 */
export function useCloudChatSignInInside(
  agentName: string | undefined
): CloudChatSignInInside | null {
  const t = useTranslate()
  const cloudHost = useCloudChatHost()
  const accounts = useOrcaCloudAgentAccounts(cloudHost)
  const agent = agentSessionSetupFor(agentName)?.agent
  if (!cloudHost || (agent !== 'claude' && agent !== 'codex')) {
    return null
  }
  return orcaCloudAgentCoverageFromAccounts(agent, accounts)?.kind === 'inWorkspace'
    ? cloudChatSignInInsideWords(agent, t)
    : null
}
