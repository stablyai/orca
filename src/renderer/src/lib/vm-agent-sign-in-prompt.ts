import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import {
  readHostAgentSignInStatus,
  refreshHostAgentSignInStatus
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { openHostAgentSignInDialog } from '@/components/settings/accounts/sign-in/host-agents/host-agent-sign-in-dialog-state'

/** After a VM workspace is created, offer the "Sign in agents" step when an agent there is signed out. */
export async function offerAgentSignInForNewVm(
  environmentId: string,
  hostLabel: string
): Promise<void> {
  await refreshHostAgentSignInStatus(environmentId, { force: true })
  const view = readHostAgentSignInStatus(environmentId)
  if (view.phase !== 'ready') {
    return
  }
  const signedOut = view.report.agents.filter((entry) => entry.state === 'signedOut')
  if (signedOut.length === 0) {
    return
  }
  const agents = signedOut.map((entry) => getAgentLabel(entry.agent)).join(', ')
  const toastId = `vm-agent-sign-in:${environmentId}`
  toast(
    translate('accounts.hostAgentSignIn.toastTitle', 'Sign in agents on {{host}}', {
      host: hostLabel
    }),
    {
      id: toastId,
      description:
        signedOut.length === 1
          ? translate(
              'accounts.hostAgentSignIn.toastDescriptionOne',
              '{{agent}} isn’t signed in on this VM yet.',
              { agent: agents }
            )
          : translate(
              'accounts.hostAgentSignIn.toastDescriptionMany',
              '{{agents}} aren’t signed in on this VM yet.',
              { agents }
            ),
      duration: 20_000,
      action: {
        label: translate('accounts.hostAgentSignIn.signIn', 'Sign in'),
        onClick: () => {
          toast.dismiss(toastId)
          openHostAgentSignInDialog({ environmentId, hostLabel })
        }
      }
    }
  )
}
