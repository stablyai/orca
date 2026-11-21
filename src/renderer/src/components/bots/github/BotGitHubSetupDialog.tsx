import React, { useEffect, useState } from 'react'
import { ExternalLink, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import {
  type BotGitHubView,
  refreshBotGitHub,
  useBotGitHub,
  useGitHubAwait
} from '@/lib/bot-github-state'
import {
  closeGitHubInstall,
  followGitHubInstall,
  type GitHubInstallRecord,
  gitHubSetupOwner,
  markGitHubTurnedOn,
  minimizeGitHubInstall
} from '@/lib/bot-github-install-record'
import { readBots, updateBot } from '@/lib/bot-catalog'
import { botGitHubCalls } from '@/lib/bot-connector-host-calls'
import {
  cancelConnectorConnect,
  type ConnectorConnectView,
  useResumeAfterConnect
} from '@/lib/connector-connect-state'
import { BotHostSignInButton } from '../BotHostSignInButton'
import { useBotHostLabel } from '../use-bot-host-label'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import { signedOutHere } from '../bot-host-copy'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { botErrorMessage } from '../bot-presentation'
import { BotWhoCanAskList } from '../BotWhoCanAskList'
import {
  OrcaCloudSignInDialogBody,
  OrcaCloudSignInGate,
  orcaCloudSignInReason
} from '../orca-cloud-sign-in'
import {
  ConnectWaiting,
  ConnectorSetupHeader,
  SignedInAs,
  connectorSetupFor
} from '../connector-connect-parts'
import { useConfirmConnectorSignOut } from '../connector-sign-out-confirm'
import { botGitHubErrorMessage, gitHubPushesAs } from './bot-github-copy'
import { GitHubTryItPreview } from './GitHubTryItPreview'
import { useGitHubWhoCanAsk } from './use-github-who-can-ask'
import {
  GitHubFinishInBrowser,
  GitHubInstalledRepositories,
  useGitHubInstallTrip
} from './github-install-trip'

/** Once linked and installed, the owner picks who may ask the bot on GitHub. */
function LinkedPeople({ bot }: { bot: Bot }): React.JSX.Element {
  return <BotWhoCanAskList bot={bot} service={useGitHubWhoCanAsk(bot.hostId, true)} />
}

/** Each step follows from the cloud's state and the connect trip. */
export type BotGitHubSetupStep =
  | { kind: 'checking' }
  | { kind: 'failed'; code: string }
  | { kind: 'connect'; error: string | null }
  | { kind: 'waiting' }
  /** Signed in, no installation yet: `requested` when an organization owner must approve it. */
  | { kind: 'install'; login: string; installUrl: string; requested: boolean }
  | {
      kind: 'turn-on'
      login: string
      installations: ConnectorGitHubInstallation[]
      installUrl: string
    }
  | {
      kind: 'done'
      login: string
      /** For the asker's picture in the try-it sample. */
      userId: string
      installations: ConnectorGitHubInstallation[]
      installUrl: string
    }

/** `on`: the bot is already turned on for GitHub, so setup ends once the account is linked and installed. */
export function botGitHubSetupStep(
  view: BotGitHubView,
  connect: ConnectorConnectView,
  on: boolean
): BotGitHubSetupStep {
  if (connect.status === 'waiting') {
    return { kind: 'waiting' }
  }
  if (view.status === 'loading') {
    return { kind: 'checking' }
  }
  if (view.status !== 'ready') {
    return { kind: 'failed', code: view.status === 'off' ? 'github_off' : view.error }
  }
  const { account, installations, installUrl } = view.github
  if (!account) {
    return { kind: 'connect', error: connect.status === 'failed' ? connect.error : null }
  }
  if (installations.length === 0) {
    const requested = connect.status === 'linked' && connect.link.install === 'requested'
    return { kind: 'install', login: account.login, installUrl, requested }
  }
  return on
    ? { kind: 'done', login: account.login, userId: account.userId, installations, installUrl }
    : { kind: 'turn-on', login: account.login, installations, installUrl }
}

const GITHUB = { id: 'github', Icon: GitHubIcon } as const

function BotGitHubSetupFlow({
  bot,
  record,
  title,
  onClose
}: {
  bot: Bot
  record: GitHubInstallRecord
  /** The dialog's title while setting up; done says the bot is on GitHub. */
  title: string
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const view = useBotGitHub(bot.hostId)
  // The sign-in this setup starts was for turning the bot on: once it links where Orca is installed,
  // the bot turns on with no second click. A link from any other surface or setup doesn't count.
  const signIn = useResumeAfterConnect(bot.hostId, 'github', {
    owner: gitHubSetupOwner(record.bot),
    onStepAside: minimizeGitHubInstall,
    onLinked: () => {
      if (step.kind === 'turn-on' && bot.github === null) {
        void turnOn()
      }
    }
  })
  const connect = signIn.connect
  const githubAwait = useGitHubAwait(bot.hostId)
  const awaiting = githubAwait === 'checking'
  const [saving, setSaving] = useState(false)
  // A bot already on GitHub is done, unless a fresh sign-in needs its identity shown first.
  const on = record.turnedOn || (bot.github !== null && connect.status === 'idle')
  const step = botGitHubSetupStep(view, connect, on)
  const hostName = useBotHostLabel(bot.hostId)
  const confirmSignOut = useConfirmConnectorSignOut()
  const trip = useGitHubInstallTrip(record)

  // An organization owner approves whenever they get to it, so follow the state while this step shows.
  const installing = step.kind === 'install'
  useEffect(() => {
    if (installing) {
      followGitHubInstall()
    }
  }, [installing])

  const turnOn = async (): Promise<void> => {
    setSaving(true)
    try {
      await updateBot(bot, { github: {} })
      markGitHubTurnedOn()
    } catch (error) {
      toast.error(botErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const closeButton = (
    <Button variant="ghost" onClick={onClose}>
      {t('bots.github.setup.close', 'Close')}
    </Button>
  )
  const signedIn = (login: string): React.JSX.Element => (
    <SignedInAs
      who={`@${login}`}
      onNotYou={() =>
        void (async () => {
          const hostBots = readBots().filter((entry) => entry.hostId === bot.hostId)
          if (await confirmSignOut(hostBots, { source: 'github', login })) {
            await signIn.anotherAccount(() => botGitHubCalls(bot.hostId).unlink(), bot)
          }
        })()
      }
    />
  )
  // GitHub's install page picks the account or organization and its repositories; the list follows.
  const installed = (step: {
    kind: 'turn-on' | 'done'
    installations: ConnectorGitHubInstallation[]
    installUrl: string
  }): React.JSX.Element => (
    <GitHubInstalledRepositories
      installations={step.installations}
      installUrl={step.installUrl}
      trip={trip}
      compact={step.kind === 'done'}
    />
  )

  // This computer's sign-in lapsed while open: the same ask, then setup again. A server's failed
  // step signs in that server instead.
  if (step.kind === 'failed' && signedOutHere(step, hostName)) {
    return (
      <OrcaCloudSignInDialogBody
        title={title}
        reason={orcaCloudSignInReason('github')}
        onCancel={onClose}
        onSignedIn={() => refreshBotGitHub(bot.hostId)}
      />
    )
  }
  const signedInStep = step.kind === 'install' || step.kind === 'turn-on' || step.kind === 'done'
  const header = (
    <ConnectorSetupHeader
      connector={GITHUB}
      title={
        step.kind === 'done'
          ? t('bots.github.setup.isOn', '{{name}} is on GitHub', { name: bot.name })
          : signedInStep
            ? title
            : t('bots.github.setup.connectTitle', 'Connect GitHub')
      }
      intro={connectorSetupFor(bot, hostName)}
      line={signedInStep ? signedIn(step.login) : undefined}
      done={step.kind === 'done'}
    />
  )
  const body = ((): React.JSX.Element => {
    switch (step.kind) {
      case 'checking':
        return (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('bots.github.setup.checking', 'Checking GitHub…')}
          </p>
        )
      case 'failed':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {botGitHubErrorMessage(step.code, hostName)}
            </p>
            <DialogFooter>
              {closeButton}
              {step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut ? (
                <BotHostSignInButton bot={bot} onClose={onClose} />
              ) : step.code === 'github_off' ? null : (
                <Button onClick={() => void refreshBotGitHub(bot.hostId)}>
                  {t('bots.github.setup.retry', 'Try again')}
                </Button>
              )}
            </DialogFooter>
          </div>
        )
      case 'connect':
        // Progressive disclosure: only what connecting needs; how to ask waits for Done.
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm">
                {t(
                  'bots.github.connect.pickRepositories',
                  'Sign in and choose which repositories {{name}} can work in.',
                  { name: bot.name }
                )}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="size-3.5 shrink-0" />
                {t('bots.github.connect.readsOnly', 'Orca only reads your GitHub username and id.')}
              </p>
            </div>
            {step.error ? (
              <p role="alert" className="text-sm text-destructive">
                {botGitHubErrorMessage(step.error, hostName)}
              </p>
            ) : null}
            <DialogFooter>
              {closeButton}
              <Button autoFocus onClick={() => void signIn.start({ bot })}>
                {t('bots.github.connect.button', 'Connect GitHub')}
                <ExternalLink />
              </Button>
            </DialogFooter>
          </div>
        )
      case 'waiting':
        return (
          <ConnectWaiting
            label={t('bots.github.connect.waiting', 'Finish signing in to GitHub in your browser…')}
            onCancel={() => cancelConnectorConnect(bot.hostId, 'github')}
          />
        )
      case 'install':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {step.requested
                ? t(
                    'bots.github.connect.requested',
                    'An owner of the organization has been asked to approve the Orca app.'
                  )
                : t(
                    'bots.github.connect.notInstalled',
                    'The Orca app is not on any of your repositories yet.'
                  )}
            </p>
            {trip.inSystemBrowser ? (
              <GitHubFinishInBrowser trip={trip} url={step.installUrl} />
            ) : awaiting ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t(
                  'bots.github.setup.installing',
                  'Waiting for the install, or for an owner of the organization to approve…'
                )}
              </p>
            ) : null}
            <DialogFooter>
              {closeButton}
              <Button
                variant={step.requested ? 'outline' : 'default'}
                onClick={() => trip.open(step.installUrl, [])}
              >
                {t('bots.github.setup.install', 'Install the Orca app')}
                <ExternalLink />
              </Button>
            </DialogFooter>
          </div>
        )
      case 'turn-on':
        return (
          <div className="space-y-4">
            {installed(step)}
            <div>
              <LinkedPeople bot={bot} />
            </div>
            <DialogFooter>
              {closeButton}
              <Button autoFocus disabled={saving} onClick={() => void turnOn()}>
                {t('bots.github.connect.turnOn', 'Turn on {{name}}', { name: bot.name })}
              </Button>
            </DialogFooter>
          </div>
        )
      case 'done':
        // Who can ask is edited later in the GitHub connector's settings (BotGitHubCard), not here.
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <GitHubTryItPreview bot={bot} login={step.login} userId={step.userId} />
              <p className="text-xs text-muted-foreground">{gitHubPushesAs(bot, hostName)}</p>
            </div>
            {installed(step)}
            <DialogFooter>
              <Button autoFocus onClick={onClose}>
                {t('bots.github.setup.finish', 'Done')}
              </Button>
            </DialogFooter>
          </div>
        )
    }
  })()
  return (
    <>
      {header}
      {body}
    </>
  )
}

/** "Add connector → GitHub": one browser trip signs in and installs the Orca app, then the bot is turned on.
 *  Rendered from the saved record: minimizing closes it, overlay and all, and Expand builds it again. */
export function BotGitHubSetupDialog({
  bot,
  record
}: {
  bot: Bot
  record: GitHubInstallRecord
}): React.JSX.Element {
  const t = useTranslate()
  const open = record.surface === 'dialog'
  const title = record.wasOn
    ? t('bots.github.setup.titleOn', '{{name}} in GitHub', { name: bot.name })
    : t('bots.github.setup.title', 'Add {{name}} to GitHub', { name: bot.name })
  return (
    // The corner button, Escape and a click outside minimize; Close, Done and the pill's ✕ end setup.
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : minimizeGitHubInstall())}>
      {/* It ends on who signed in and who gets access: a trust decision. */}
      <DialogContent surface="security" closeButtonVariant="minimize" className="sm:max-w-lg">
        {open ? (
          <OrcaCloudSignInGate
            hostId={bot.hostId}
            title={title}
            reason={orcaCloudSignInReason('github')}
            onCancel={closeGitHubInstall}
            resume={() => refreshBotGitHub(bot.hostId)}
          >
            <BotGitHubSetupFlow
              bot={bot}
              record={record}
              title={title}
              onClose={closeGitHubInstall}
            />
          </OrcaCloudSignInGate>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
