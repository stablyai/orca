import React, { useState } from 'react'
import { Ellipsis, Plus, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { SettingsBadge } from '@/components/settings/form-controls/SettingsFormControls'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  GoogleAccountView,
  GoogleStatusView
} from '../../../../../shared/google/google-connect-types'
import {
  GOOGLE_SERVICE_INFO,
  type GoogleServiceChoice
} from '../../../../../shared/google/google-scopes'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { STATUS_DOT_CLASSES } from '../bot-connector-row-parts'
import {
  googleAccountChoices,
  googleReadinessFixer,
  useRecheckWhileBroken
} from './google-account-readiness'
import { GoogleAddServiceDialog } from './GoogleAddServiceDialog'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { disconnectGoogle, refreshGoogle } from './google-connect-client'
import {
  googleFixLabel,
  googleProblems,
  googleReadinessFace,
  googleRowProblem
} from './google-copy'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One Google account in Settings › Google, styled like the GitHub accounts list: its services or its
 * first problem with that fix, Set as default, and a menu with Add a service and Remove.
 */
export function GoogleAccountRow({
  target,
  google,
  account,
  isDefault,
  nextDefault,
  canSetDefault,
  signIn
}: {
  target: RuntimeClientTarget
  google: GoogleStatusView
  account: GoogleAccountView
  isDefault: boolean
  /** The account that takes over when this default is removed. */
  nextDefault: string | null
  /** False on a host too old to keep a default. */
  canSetDefault: boolean
  signIn: (services: readonly GoogleServiceChoice[], account: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const confirm = useConfirmationDialog()
  const [adding, setAdding] = useState(false)
  const client = google.client
  const choices = googleAccountChoices(account)
  const connected = account.status === 'connected'
  const problem = connected ? (googleProblems(account)[0] ?? null) : null
  useRecheckWhileBroken(target, connected && problem?.readiness.state === 'api-disabled')
  const fix = googleReadinessFixer({
    target,
    account,
    clientId: client?.clientId ?? null,
    projectId: client?.projectId ?? null,
    onAllowAgain: (services) => signIn(services, account.email)
  })
  const face = problem ? googleReadinessFace(problem.readiness) : null
  // Drive stands for Docs and Sheets too, as the service picker groups them.
  const ready = new Set(
    account.services.filter((entry) => entry.state === 'ready').map((entry) => entry.service)
  )
  const servicesLine = new Intl.ListFormat(intlLocale, { type: 'conjunction' }).format(
    (['gmail', 'calendar', 'drive'] as const)
      .filter((service) => ready.has(service))
      .map((service) => GOOGLE_SERVICE_INFO[service].label)
  )

  const disconnect = async (revoke: boolean): Promise<void> => {
    const promoted =
      isDefault && nextDefault
        ? ` ${t('bots.google.disconnect.promotes', '{{email}} becomes the default.', {
            email: nextDefault
          })}`
        : ''
    const confirmed = await confirm({
      title: t('bots.google.disconnect.title', 'Disconnect {{email}}?', {
        email: account.email
      }),
      description:
        (revoke
          ? t(
              'bots.google.disconnect.revokeNote',
              'Bots stop using this account here, and Google cancels Orca’s access everywhere it was allowed.'
            )
          : google.accounts.length > 1
            ? t('bots.google.disconnect.removeOneNote', 'Bots stop using this account here.')
            : t(
                'bots.google.disconnect.removeNote',
                'Bots stop using this account here. Bot settings stay, so Connect Google turns it back on.'
              )) + promoted,
      confirmLabel: t('bots.google.disconnect.confirm', 'Disconnect'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await disconnectGoogle(target, account.email, revoke).catch((error: unknown) =>
        toast.error(errorText(error))
      )
    }
  }

  const makeDefault = (): void => {
    void callRuntimeRpc(target, 'google.default.set', { account: account.email })
      .then(() => refreshGoogle(target))
      .catch((error: unknown) => toast.error(errorText(error)))
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{account.email}</span>
          {isDefault ? (
            <SettingsBadge className="shrink-0 border-foreground/30 text-foreground">
              {t('bots.google.defaultBadge', 'Default')}
            </SettingsBadge>
          ) : null}
        </p>
        {!connected || problem ? (
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className={STATUS_DOT_CLASSES.attention} aria-hidden />
            {problem
              ? googleRowProblem(problem)
              : t('bots.google.row.signedOut', 'Signed out by Google')}
          </p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{servicesLine}</p>
        )}
      </div>
      {!connected ? (
        <Button size="sm" onClick={() => signIn(choices, account.email)}>
          {t('bots.google.reconnect', 'Reconnect')}
        </Button>
      ) : problem && face?.fix ? (
        <Button size="sm" variant="outline" onClick={() => fix(problem.readiness)}>
          {googleFixLabel(face.fix)}
        </Button>
      ) : null}
      {canSetDefault && !isDefault ? (
        <Button size="sm" variant="outline" onClick={makeDefault}>
          {t('bots.google.setDefault', 'Set as default')}
        </Button>
      ) : null}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('bots.google.accountActions', '{{email}} actions', {
              email: account.email
            })}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {connected ? (
            <>
              <DropdownMenuItem onSelect={() => setAdding(true)}>
                <Plus />
                {t('bots.google.addServiceMenu', 'Add a service…')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => void disconnect(false)}>
            <Unplug />
            {t('bots.google.disconnect.remove', 'Remove from this computer')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void disconnect(true)}>
            <Unplug />
            {t('bots.google.disconnect.revoke', 'Remove and revoke at Google')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <GoogleAddServiceDialog
        open={adding}
        onOpenChange={setAdding}
        have={choices}
        projectId={client?.projectId}
        account={account.email}
        onSignIn={(picked) => {
          setAdding(false)
          signIn(picked, account.email)
        }}
      />
    </div>
  )
}
