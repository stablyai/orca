import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { rememberHostAgentSignInReport } from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import {
  HOST_AGENT_SIGN_IN_AGENT_NAME,
  type HostAgentSignInAgent,
  type HostAgentSignInReport
} from '../../../../shared/host-agent-sign-in-status'

const AGENT_NAME = HOST_AGENT_SIGN_IN_AGENT_NAME

/** Runs the agent's own logout on the host; resolves whether it worked. */
export async function signOutAgentOnHost(
  environmentId: string,
  hostLabel: string,
  agent: HostAgentSignInAgent,
  detail?: string
): Promise<boolean> {
  const name = AGENT_NAME[agent]
  try {
    const report = await callRuntimeRpc<HostAgentSignInReport>(
      { kind: 'environment', environmentId },
      'accounts.agentSignOut',
      { agent },
      { timeoutMs: 30_000 }
    )
    rememberHostAgentSignInReport(environmentId, report)
    toast.success(
      translate('agentSignIn.signedOutToast', 'Signed out of {{agent}} on {{host}}', {
        agent: name,
        host: hostLabel
      }),
      detail ? { description: detail } : undefined
    )
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate('agentSignIn.signOutFailed', 'Could not sign out on {{host}}.', {
            host: hostLabel
          })
    )
    return false
  }
}

/** Signs the host's agent out so the next start signs in again, with the browser on the other account. */
export function switchHostAgentAccount(
  environmentId: string,
  hostLabel: string,
  agent: HostAgentSignInAgent
): Promise<boolean> {
  return signOutAgentOnHost(
    environmentId,
    hostLabel,
    agent,
    translate(
      'agentSignIn.switchAccountDetail',
      'Switch accounts in your browser, then start {{agent}} there again to sign in.',
      { agent: AGENT_NAME[agent] }
    )
  )
}

/** Not an error: the agent starts anyway, and the warning outlives the card so it can be acted on. */
export function warnHostAgentOtherAccount(
  host: { key: string; environmentId: string; hostLabel: string; agent: HostAgentSignInAgent },
  email: string,
  expectedEmail: string
): void {
  const agent = AGENT_NAME[host.agent]
  toast.warning(
    translate('agentSignIn.otherAccountToast', '{{agent}} on {{host}} is signed in as {{email}}', {
      agent,
      host: host.hostLabel,
      email
    }),
    {
      id: `agent-sign-in-other-account:${host.key}`,
      duration: 20_000,
      description: translate(
        'agentSignIn.otherAccountDetail',
        'This computer uses {{email}} for {{agent}}.',
        { email: expectedEmail, agent }
      ),
      action: {
        label: translate('agentSignIn.switchAccount', 'Switch account'),
        onClick: () => void switchHostAgentAccount(host.environmentId, host.hostLabel, host.agent)
      }
    }
  )
}
