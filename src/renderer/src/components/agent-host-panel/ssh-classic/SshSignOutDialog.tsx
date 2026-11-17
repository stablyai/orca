// Sign out of one agent on a classic SSH host: runs the CLI's own sign-out there over SSH.
import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { signOutSshAgent } from '@/lib/ssh-agent-sign-in/ssh-agent-sign-in-store'
import {
  HOST_AGENT_SIGN_IN_AGENT_NAME,
  type HostAgentSignInAgent
} from '../../../../../shared/host-agent-sign-in-status'

export function SshSignOutDialog({
  targetId,
  hostLabel,
  agent,
  onClose
}: {
  targetId: string
  hostLabel: string
  agent: HostAgentSignInAgent | null
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const name = agent ? HOST_AGENT_SIGN_IN_AGENT_NAME[agent] : ''
  return (
    <Dialog open={agent !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent size="confirm" busy={busy}>
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
          <DialogCancel>{t('agentSignIn.cancel', 'Cancel')}</DialogCancel>
          <Button
            size="sm"
            autoFocus
            disabled={busy}
            onClick={() => {
              if (!agent) {
                return
              }
              setBusy(true)
              void signOutSshAgent(targetId, agent).finally(() => {
                setBusy(false)
                onClose()
              })
            }}
          >
            {busy
              ? t('agentSignIn.signingOut', 'Signing out…')
              : t('agentSignIn.signOut', 'Sign out')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
