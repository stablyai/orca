// Whether Sign in on <server> can start from this window, and what a server shows where it can't.
import React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  refreshBotHostOrcaAccount,
  useBotHostOrcaAccount,
  useBotHostOrcaAccountSettled
} from '@/lib/bot-host-orca-account'
import { useBotHostHas, useBotHostVerified } from '@/lib/bot-host-status'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY } from '../../../../shared/orca-account-runtime-capabilities'

/**
 * Whether Sign in on <server> can start here: 'start' only for a verified server that takes an
 * approve-in-browser sign-in; 'update' for a verified older one, whose sign-in waits on a pasted code
 * this window can't give; null while its status isn't verified, or where a sign-in can't work.
 */
export type BotHostSignInFromHere =
  | 'start'
  | 'update'
  | 'unconfigured'
  | 'unread'
  | { cantSave: string }
  | null

export function useBotHostSignInFromHere(hostId: ExecutionHostId): BotHostSignInFromHere {
  const verified = useBotHostVerified(hostId)
  const approves = useBotHostHas(hostId, ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY)
  const account = useBotHostOrcaAccount(hostId)
  const settled = useBotHostOrcaAccountSettled(hostId)
  if (!verified) {
    return null
  }
  if (!approves) {
    return 'update'
  }
  // Only a read account says a sign-in can work: a build without one, or a server that can't save
  // one, would only fail, and an unread or failed read proves nothing.
  if (!account) {
    return settled ? 'unread' : null
  }
  if (account.state === 'unconfigured') {
    return 'unconfigured'
  }
  if (account.state !== 'signed-in' && account.storage.kind === 'refused') {
    return { cantSave: account.storage.reason }
  }
  return 'start'
}

/** What a server shows where Sign in on <server> can't start, with how to get there; null for nothing. */
export function BotHostSignInBlocked({
  hostId,
  host,
  why
}: {
  hostId: ExecutionHostId
  host: string
  why: Exclude<BotHostSignInFromHere, 'start' | null>
}): React.JSX.Element {
  const t = useTranslate()
  if (why === 'update') {
    return <p>{signInUpdateFirst(host)}</p>
  }
  if (why === 'unconfigured') {
    return (
      <p>
        {t(
          'bots.host.signIn.unconfigured',
          'Orca on {{host}} was built without Orca Cloud sign-in. Install Orca’s release build there to sign it in.',
          { host }
        )}
      </p>
    )
  }
  if (why === 'unread') {
    return (
      <div className="flex flex-col gap-1">
        <p>{t('bots.host.signIn.unread', 'Couldn’t read {{host}}’s Orca sign-in.', { host })}</p>
        <Button
          variant="outline"
          size="xs"
          className="self-start"
          onClick={() => void refreshBotHostOrcaAccount(hostId)}
        >
          {t('bots.host.signIn.readAgain', 'Try again')}
        </Button>
      </div>
    )
  }
  return (
    <>
      <p>
        {t('bots.host.notice.cantSave', '{{host}} can’t save an Orca sign-in: {{reason}}', {
          host,
          reason: why.cantSave
        })}
      </p>
      <p>
        {t(
          'bots.host.notice.cantSaveNext',
          'Unlock or set up a keychain on {{host}} and restart Orca there, then sign it in here.',
          { host }
        )}
      </p>
    </>
  )
}

/** What an older server shows where Sign in on <server> would be. */
export function signInUpdateFirst(host: string): string {
  return translate(
    'bots.host.signIn.updateFirst',
    'Update Orca on {{host}}, then sign it in from here.',
    { host }
  )
}
