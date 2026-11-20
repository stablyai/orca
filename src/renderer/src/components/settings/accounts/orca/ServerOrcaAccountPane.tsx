// Settings › Orca Account with a server picked: the account that server runs as, and its sign-in.
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount, useBotHostOrcaAccountSettled } from '@/lib/bot-host-orca-account'
import { BotHostSignInControl } from '../../../bots/BotConnectorsHostNotice'
import { useBotHostLabel } from '../../../bots/use-bot-host-label'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { OrcaAccountServerStatus } from '../../../../../../shared/orca-account-server-sign-in'
import { accountStatusCopy, OrcaAccountHeader } from './OrcaAccountSettingsPane'

const PROFILE_STATE = {
  'signed-in': 'connected',
  'signed-out': 'local',
  'reconnect-required': 'reconnect-required',
  unconfigured: 'unconfigured'
} as const satisfies Record<OrcaAccountServerStatus['state'], string>

export function ServerOrcaAccountPane({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element {
  const t = useTranslate()
  const hostId = toRuntimeExecutionHostId(environmentId)
  const host =
    useBotHostLabel(hostId) ??
    t('components.settings.notifications.server.fallbackHost', 'this server')
  const account = useBotHostOrcaAccount(hostId)
  // An Orca too old to say its sign-in reads as one that can't sign in.
  const settled = useBotHostOrcaAccountSettled(hostId)
  const state = account ? PROFILE_STATE[account.state] : settled ? 'unconfigured' : undefined
  const canSignIn = account?.state === 'signed-out' || account?.state === 'reconnect-required'
  return (
    <OrcaAccountHeader
      name={account?.displayName}
      connected={account?.state === 'signed-in'}
      line={accountStatusCopy(state, account?.email, t)}
    >
      {canSignIn ? (
        <BotHostSignInControl
          hostId={hostId}
          host={host}
          bot={null}
          label={
            account.state === 'signed-out'
              ? t('bots.host.signIn.start', 'Sign in on {{host}}', { host })
              : t('bots.host.signIn.again', 'Sign {{host}} in again', { host })
          }
          firstSignIn={account.state === 'signed-out'}
        />
      ) : null}
    </OrcaAccountHeader>
  )
}
