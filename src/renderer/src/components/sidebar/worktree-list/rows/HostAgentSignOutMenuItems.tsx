import { useEffect, useSyncExternalStore } from 'react'
import { LogOut } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  readHostAgentSignInReport,
  refreshHostAgentSignInReport,
  rememberHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import type {
  HostAgentSignInAgent,
  HostAgentSignInReport
} from '../../../../../../shared/host-agent-sign-in-status'

const AGENT_NAME: Record<HostAgentSignInAgent, string> = { claude: 'Claude', codex: 'Codex' }

async function signOut(
  environmentId: string,
  hostLabel: string,
  agent: HostAgentSignInAgent
): Promise<void> {
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
      {
        description: translate(
          'agentSignIn.signedOutDetail',
          'The next {{agent}} you start there asks to sign in.',
          { agent: name }
        )
      }
    )
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate('agentSignIn.signOutFailed', 'Could not sign out on {{host}}.', {
            host: hostLabel
          })
    )
  }
}

/** "Sign out of Claude/Codex" for agents the host reports signed in; nothing otherwise. */
export function HostAgentSignOutMenuItems({
  environmentId,
  hostLabel,
  open
}: {
  environmentId: string
  hostLabel: string
  open: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const report = useSyncExternalStore(subscribeHostAgentSignInReports, () =>
    readHostAgentSignInReport(environmentId)
  )
  useEffect(() => {
    if (open) {
      // Asked only when the menu opens; the host answers from its own one-minute cache.
      void refreshHostAgentSignInReport(environmentId)
    }
  }, [environmentId, open])
  // API-key logins live in the host's own environment, which Orca does not manage.
  const signedIn = (report?.agents ?? []).filter(
    (entry) => entry.state === 'signedIn' && entry.method !== 'apiKey'
  )
  if (signedIn.length === 0) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="truncate text-[11px] font-medium text-muted-foreground">
        {t('agentSignIn.menuLabel', 'Agents on {{host}}', { host: hostLabel })}
      </DropdownMenuLabel>
      {signedIn.map((entry) => (
        <DropdownMenuItem
          key={entry.agent}
          onSelect={() => void signOut(environmentId, hostLabel, entry.agent)}
        >
          <LogOut className="size-3.5" />
          {t('agentSignIn.signOutOf', 'Sign out of {{agent}}', { agent: AGENT_NAME[entry.agent] })}
        </DropdownMenuItem>
      ))}
    </>
  )
}
