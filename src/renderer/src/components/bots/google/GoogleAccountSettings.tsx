import React, { useState } from 'react'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { GoogleIcon } from '@/components/icons/GoogleIcon'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { GoogleStatusView } from '../../../../../shared/google/google-connect-types'
import type { GoogleServiceChoice } from '../../../../../shared/google/google-scopes'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { googleSignInChoices } from './google-account-readiness'
import { GoogleAccountRow } from './GoogleAccountRow'
import { GoogleServicePicker } from './GoogleServicePicker'
import { GoogleSignInWaiting } from './GoogleSignInWaiting'
import { GoogleSignInFailed } from './GoogleSignInTrouble'
import { GoogleUseAnotherAccountMenu } from './GoogleUseAnotherAccountMenu'
import { useGoogleSetupStart } from './use-google-setup-start'
import { useGoogleHostLabel } from './use-google-host-label'
import { useGoogleNewApp } from './use-google-new-app'
import {
  importGoogleApp,
  refreshGoogle,
  shareGoogleApp,
  useGoogleHost
} from './google-connect-client'
import { useGoogleClientFile } from './use-google-client-file'
import { useGoogleSignIn } from './use-google-sign-in'

/** No app on this host: a bot sets one up in its chat, or the person imports the team's file. */
function NoApp({
  hostId,
  file
}: {
  hostId: ExecutionHostId
  file: ReturnType<typeof useGoogleClientFile>
}): React.JSX.Element {
  const t = useTranslate()
  const setup = useGoogleSetupStart(hostId)
  const bot = setup.bot
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {bot ? (
          <>
            <Button size="sm" onClick={() => setup.start()}>
              {t('bots.google.setUp', 'Set up Google')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t('bots.google.setUpOpens', 'Opens {{bot}}’s chat', { bot: bot.name })}
            </span>
          </>
        ) : (
          <Button size="sm" onClick={() => setup.start()}>
            {t('bots.google.createBotToSetUp', 'New bot')}
          </Button>
        )}
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{t('bots.google.setUpTime', 'About 10 minutes')}</p>
        <p>
          {t('bots.google.haveSetupFile', 'Have a setup file from your team?')}{' '}
          <Button
            variant="link"
            size="inlineText"
            disabled={file.busy}
            onClick={() => void file.pick()}
          >
            {t('bots.google.importSetupFile', 'Import file')}
          </Button>
        </p>
      </div>
      {file.error ? (
        <p role="alert" className="text-sm text-destructive">
          {file.error}
        </p>
      ) : null}
      {setup.dialog}
    </div>
  )
}

/** Set up a new Google app from this panel, in the host's last-visited agent's chat. */
function useNewAppSetup(
  target: RuntimeClientTarget,
  signIn: ReturnType<typeof useGoogleSignIn>
): { newApp: () => void; notices: React.ReactNode } {
  const setup = useGoogleSetupStart(getRuntimeTargetHostId(target))
  const { newApp, updateNotice } = useGoogleNewApp(target, signIn, () =>
    setup.start({ newApp: true })
  )
  return {
    newApp,
    notices: (
      <>
        {updateNotice}
        {setup.dialog}
      </>
    )
  }
}

/** The app is here and nobody is signed in: pick services, then Connect Google. */
function ConnectPanel({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
  const t = useTranslate()
  const [choices, setChoices] = useState<GoogleServiceChoice[]>(['gmail'])
  const signIn = useGoogleSignIn(target)
  const setup = useNewAppSetup(target, signIn)
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">
        {t('bots.google.appAdded', 'Your team’s Google app is added')}
      </p>
      <GoogleServicePicker value={choices} onChange={setChoices} />
      {signIn.state.kind === 'waiting' ? (
        <GoogleSignInWaiting
          state={signIn.state}
          onCancel={signIn.cancel}
          onNewApp={setup.newApp}
        />
      ) : (
        <div className="space-y-2">
          {signIn.state.kind === 'failed' ? (
            <GoogleSignInFailed error={signIn.state.error} onNewApp={setup.newApp} />
          ) : null}
          <Button
            size="sm"
            disabled={choices.length === 0}
            onClick={() => void signIn.connect(choices)}
          >
            {t('bots.google.connect', 'Connect Google')}
          </Button>
        </div>
      )}
      {setup.notices}
    </div>
  )
}

/** The accounts as rows, then Use another account and Share setup under them. */
function AccountList({
  target,
  google,
  host
}: {
  target: RuntimeClientTarget
  google: GoogleStatusView
  host: string
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const signIn = useGoogleSignIn(target)
  const setup = useNewAppSetup(target, signIn)
  const client = google.client
  // Absent from a host too old to keep a default, where a second account would break its calls.
  const defaultAccount = google.defaultAccount
  const canAdd = defaultAccount !== undefined
  const fallback = google.accounts.find((account) => account.email === defaultAccount)
  const nextDefault = google.accounts.find((account) => account.email !== defaultAccount)
  const connect = (services: readonly GoogleServiceChoice[], account?: string): void =>
    void signIn.connect(services, account)
  return (
    <div className="space-y-3">
      <div className="divide-y divide-border rounded-md border border-border">
        {google.accounts.map((account) => (
          <GoogleAccountRow
            key={account.email}
            target={target}
            google={google}
            account={account}
            isDefault={account.email === defaultAccount}
            nextDefault={nextDefault?.email ?? null}
            canSetDefault={canAdd}
            signIn={connect}
          />
        ))}
      </div>
      {signIn.state.kind === 'waiting' ? (
        <GoogleSignInWaiting
          state={signIn.state}
          onCancel={signIn.cancel}
          onNewApp={setup.newApp}
        />
      ) : signIn.state.kind === 'failed' ? (
        <GoogleSignInFailed error={signIn.state.error} onNewApp={setup.newApp} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {canAdd ? (
          <GoogleUseAnotherAccountMenu
            disabled={signIn.state.kind === 'waiting'}
            onSignIn={() => connect(googleSignInChoices(fallback))}
            onNewApp={setup.newApp}
          />
        ) : null}
        {client ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => shareGoogleApp(target, client.projectId)}
          >
            {t('bots.google.shareButton', 'Share setup')}
          </Button>
        ) : null}
      </div>
      {canAdd ? null : (
        <p className="text-xs text-muted-foreground">
          {t('bots.google.updateToAdd', 'Update Orca on {{host}} to add another Google account.', {
            host
          })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {google.bots.length > 0
          ? t('bots.google.onFor', 'On for {{bots}}.', {
              bots: new Intl.ListFormat(intlLocale, { type: 'conjunction' }).format(
                google.bots.map((bot) => bot.name)
              )
            })
          : t('bots.google.turnOnForBot', 'Turn Google on for a bot from the bot’s Connectors.')}
      </p>
      {setup.notices}
    </div>
  )
}

/** Settings › Bots › Google: the team's app on this host, the accounts signed in, and their services. */
export function GoogleAccountSettings({
  target
}: {
  target: RuntimeClientTarget
}): React.JSX.Element | null {
  const t = useTranslate()
  const view = useGoogleHost(target)
  const host = useGoogleHostLabel(target)
  const file = useGoogleClientFile(async (text) => {
    await importGoogleApp(target, text)
  })
  if (view.status === 'loading') {
    return null
  }
  // With no app yet, a team's file dropped anywhere here imports it.
  const noApp = view.status === 'ready' && !view.google.client
  const title = noApp ? (
    <span className="flex items-center gap-2">
      <GoogleIcon className="size-4 shrink-0" />
      {t('bots.google.connect', 'Connect Google')}
    </span>
  ) : (
    t('bots.google.title', 'Google')
  )
  const description = noApp
    ? t(
        'bots.google.connectDescription',
        'Give your bots access to Gmail, Calendar and Drive. Your sign-in stays on {{host}}.',
        { host }
      )
    : t(
        'bots.google.description',
        'Let your bots use Gmail, Calendar and Drive as you. Your Google sign-in stays on {{host}}.',
        { host }
      )
  const header = <SettingsSubsectionHeader title={title} description={description} />
  let body: React.ReactNode
  if (view.status === 'update-server') {
    body = (
      <p className="text-sm text-muted-foreground">
        {t('bots.google.updateServer', 'Update this server to connect Google.')}
      </p>
    )
  } else if (view.status === 'failed') {
    body = (
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{view.error}</p>
        <Button size="sm" variant="outline" onClick={() => void refreshGoogle(target)}>
          {t('bots.google.retry', 'Try again')}
        </Button>
      </div>
    )
  } else if (!view.google.client) {
    body = <NoApp hostId={getRuntimeTargetHostId(target)} file={file} />
  } else if (view.google.accounts.length === 0) {
    body = <ConnectPanel target={target} />
  } else {
    body = <AccountList target={target} google={view.google} host={host} />
  }
  return (
    <section
      {...(noApp ? file.dropTarget : {})}
      className="space-y-3 rounded-md outline-offset-4 data-[dragging=true]:outline-2 data-[dragging=true]:outline-dashed data-[dragging=true]:outline-ring"
    >
      {header}
      {body}
    </section>
  )
}
