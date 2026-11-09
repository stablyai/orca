import { useEffect, useState, useSyncExternalStore } from 'react'
import { LogOut } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import {
  readHostAgentSignInReport,
  refreshHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { signOutAgentOnHost } from '@/lib/agent-sign-in/host-agent-sign-out'
import type { HostAgentSignInAgent } from '../../../../../../shared/host-agent-sign-in-status'

const AGENT_NAME: Record<HostAgentSignInAgent, string> = { claude: 'Claude', codex: 'Codex' }

/** "Sign out of Claude/Codex" for agents the host reports signed in; nothing otherwise. */
export function HostAgentSignOutMenuItems({
  environmentId,
  hostLabel,
  open,
  onSignOut
}: {
  environmentId: string
  hostLabel: string
  open: boolean
  onSignOut: (agent: HostAgentSignInAgent) => void
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
  // API-key logins live in the host's own environment, which a sign-out doesn't touch.
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
        <DropdownMenuItem key={entry.agent} onSelect={() => onSignOut(entry.agent)}>
          <LogOut className="size-3.5" />
          {t('agentSignIn.signOutOf', 'Sign out of {{agent}}…', { agent: AGENT_NAME[entry.agent] })}
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** Confirms a plain logout of one agent on one host before running it there. */
export function HostAgentSignOutDialog({
  environmentId,
  hostLabel,
  agent,
  onClose
}: {
  environmentId: string
  hostLabel: string
  agent: HostAgentSignInAgent | null
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const name = agent ? AGENT_NAME[agent] : ''
  return (
    <Dialog open={agent !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('agentSignIn.signOutTitle', 'Sign out of {{agent}} on {{host}}?', {
              agent: name,
              host: hostLabel
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'agentSignIn.signOutBody',
              'Runs {{agent}}’s own sign-out on {{host}}. The next {{agent}} you start there asks you to sign in. Agents already running there aren’t stopped, and saved accounts stay listed.',
              { agent: name, host: hostLabel }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('agentSignIn.cancel', 'Cancel')}
          </Button>
          <Button
            autoFocus
            disabled={busy}
            onClick={() => {
              if (!agent) {
                return
              }
              setBusy(true)
              void signOutAgentOnHost(environmentId, hostLabel, agent).finally(() => {
                setBusy(false)
                onClose()
              })
            }}
          >
            {busy ? <LoadingSpinner className="size-4" /> : null}
            {t('agentSignIn.signOut', 'Sign out')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
