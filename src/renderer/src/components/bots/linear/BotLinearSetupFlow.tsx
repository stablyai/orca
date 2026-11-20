// @protected-copy: drawn inside the security-surface setup dialog
// The steps of "Add <bot> to Linear" inside its dialog: sign in, pick a workspace, install, turn on.
import React, { useEffect, useState } from 'react'
import { Copy, ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { readHostBots, updateBot } from '@/lib/bot-catalog'
import {
  awaitLinearChange,
  refreshBotLinear,
  useBotLinear,
  useLinearAwait
} from '@/lib/bot-linear-state'
import { cancelConnectorConnect, useResumeAfterConnect } from '@/lib/connector-connect-state'
import { botLinearCalls } from '@/lib/bot-connector-host-calls'
import { BotHostSignInButton } from '../BotHostSignInButton'
import { useBotHostLabel } from '../use-bot-host-label'
import { botLinearWorkspaces, type Bot } from '../../../../../shared/bot-types'
import type { ConnectorLinearWorkspace } from '../../../../../shared/connector-bot-linear-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { botErrorMessage } from '../bot-presentation'
import {
  ConnectWaiting,
  ConnectorMoreLink,
  ConnectorSetupHeader,
  ConnectorWorkspacePicker,
  SignedInAs,
  connectorSetupFor
} from '../connector-connect-parts'
import { ConnectorTryIt } from '../ConnectorTryIt'
import { useConfirmConnectorSignOut } from '../connector-sign-out-confirm'
import type { useSetupStepAside } from '../connector-setup-surface'
import {
  botLinearErrorMessage,
  linearActsAs,
  linearLabel,
  linearMention,
  linearWorkspaceLabel
} from './bot-linear-copy'
import { LinkedPeople } from './LinearSetupParts'
import { botLinearSetupStep, withLinearWorkspace } from './linear-setup-step'
import { OrcaCloudSignInDialogBody, orcaCloudSignInReason } from '../orca-cloud-sign-in'

export const LINEAR = { id: 'linear', Icon: LinearIcon } as const

/** The setup's own sign-in trips, so only those carry it on (useResumeAfterConnect). */
function linearSetupOwner(bot: Bot): string {
  return `linear-setup:${bot.hostId}:${bot.id}`
}

export function BotLinearSetupFlow({
  bot,
  workspaceId,
  on,
  title,
  onClose,
  aside
}: {
  bot: Bot
  workspaceId: string | undefined
  /** Already on in `workspaceId`: the dialog only edits who can ask. */
  on: boolean
  /** The dialog's title while setting up; done says the bot is on Linear. */
  title: string
  onClose: () => void
  /** Steps aside while Linear's page is open in Orca's browser, behind the dialog. */
  aside: ReturnType<typeof useSetupStepAside>
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const [done, setDone] = useState(false)
  // The workspace just turned on, listed on the done screen.
  const [doneIn, setDoneIn] = useState<ConnectorLinearWorkspace | null>(null)
  // A workspace chosen from the picker, when several are linked.
  const [picked, setPicked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const view = useBotLinear(bot.hostId)
  // The sign-in this setup starts was for turning the bot on: once it links one workspace where Orca is
  // installed, the bot turns on there with no second click.
  const signIn = useResumeAfterConnect(bot.hostId, 'linear', {
    owner: linearSetupOwner(bot),
    onStepAside: aside.stepAside,
    away: aside.away,
    onLinked: () => {
      if (step.kind === 'turn-on' && !on) {
        void turnOn(step.workspace)
      }
    }
  })
  const connect = signIn.connect
  // Back from Linear's page once the sign-in ends, either way.
  const { away, comeBack } = aside
  const signInEnded = connect.status !== 'waiting'
  useEffect(() => {
    if (away && signInEnded) {
      comeBack()
    }
  }, [away, signInEnded, comeBack])
  const linearAwait = useLinearAwait(bot.hostId)
  // A row's own workspace; from Add a connector, another than the bot's.
  const step = botLinearSetupStep(view, connect, {
    workspaceId: picked ?? workspaceId ?? null,
    done,
    taken:
      workspaceId === undefined ? botLinearWorkspaces(bot).map((entry) => entry.workspaceId) : []
  })
  const confirmSignOut = useConfirmConnectorSignOut()

  // An admin installs whenever they get to it, so follow the state while this step shows.
  const needsAdmin = step.kind === 'needs-admin'
  useEffect(() => {
    if (needsAdmin) {
      void awaitLinearChange(bot.hostId)
    }
  }, [bot.hostId, needsAdmin])

  const turnOn = async (workspace: ConnectorLinearWorkspace): Promise<void> => {
    setSaving(true)
    try {
      await updateBot(bot, {
        linearWorkspaces: withLinearWorkspace(botLinearWorkspaces(bot), workspace)
      })
      setDoneIn(workspace)
      setDone(true)
    } catch (error) {
      toast.error(botErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const closeButton = (
    <Button variant="ghost" onClick={onClose}>
      {t('bots.linear.setup.close', 'Close')}
    </Button>
  )
  // Linear's consent screen again, to pick another workspace; the ones linked stay linked.
  const addAnotherWorkspace = (): void => void signIn.start({ switchAccount: true, bot })
  const anotherWorkspaceLabel = t('bots.linear.connect.another', 'Use another workspace')
  // A failed "Use another workspace" trip keeps what is linked, and says why.
  const tripError =
    connect.status === 'failed' ? (
      <p role="alert" className="text-sm text-destructive">
        {botLinearErrorMessage(connect.error, hostName)}
      </p>
    ) : null
  const signedIn = (workspace: ConnectorLinearWorkspace): React.JSX.Element => (
    <SignedInAs
      who={t('bots.linear.connect.who', '{{name}} in {{workspace}}', {
        name: workspace.userName || workspace.userId,
        workspace: linearWorkspaceLabel(workspace.name, workspace.urlKey)
      })}
      onNotYou={() =>
        void (async () => {
          const signOut = {
            source: 'linear' as const,
            workspaceId: workspace.workspaceId,
            workspaceName: workspace.name
          }
          if (await confirmSignOut(readHostBots(bot.hostId), signOut)) {
            await signIn.anotherAccount(
              () => botLinearCalls(bot.hostId).unlink({ workspaceId: workspace.workspaceId }),
              bot
            )
          }
        })()
      }
    />
  )
  const anotherWorkspace = (
    <div className="space-y-1">
      <ConnectorMoreLink more={{ label: anotherWorkspaceLabel, onClick: addAnotherWorkspace }} />
      {tripError}
    </div>
  )

  // The cloud said signed out (a sign-in that lapsed while open): the same ask, then setup again.
  if (step.kind === 'failed' && step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return (
      <OrcaCloudSignInDialogBody
        title={title}
        reason={orcaCloudSignInReason('linear')}
        onCancel={onClose}
        onSignedIn={() => refreshBotLinear(bot.hostId)}
      />
    )
  }
  const signedInAt =
    step.kind === 'turn-on' || step.kind === 'needs-admin'
      ? step.workspace
      : step.kind === 'done'
        ? doneIn
        : null
  const header = (
    <ConnectorSetupHeader
      connector={LINEAR}
      title={
        step.kind === 'done'
          ? t('bots.linear.setup.isOn', '{{name}} is on Linear', { name: bot.name })
          : signedInAt
            ? title
            : t('bots.linear.setup.connectTitle', 'Connect Linear')
      }
      intro={connectorSetupFor(bot, hostName)}
      line={signedInAt ? signedIn(signedInAt) : undefined}
      done={step.kind === 'done'}
    />
  )
  const body = ((): React.JSX.Element => {
    switch (step.kind) {
      case 'checking':
        return (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('bots.linear.setup.checking', 'Checking Linear…')}
          </p>
        )
      case 'failed':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {botLinearErrorMessage(step.code, hostName)}
            </p>
            <DialogFooter>
              {closeButton}
              {step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut ? (
                <BotHostSignInButton bot={bot} onClose={onClose} />
              ) : step.code === 'linear_off' ? null : (
                <Button onClick={() => void refreshBotLinear(bot.hostId)}>
                  {t('bots.linear.setup.retry', 'Try again')}
                </Button>
              )}
            </DialogFooter>
          </div>
        )
      case 'connect':
        // Progressive disclosure: only what connecting needs; how to ask waits for Done.
        return (
          <div className="space-y-4">
            <p className="text-sm">
              {t(
                'bots.linear.connect.pickWorkspace',
                'Sign in and pick the Linear workspace {{name}} works in.',
                { name: bot.name }
              )}
            </p>
            {step.error ? (
              <p role="alert" className="text-sm text-destructive">
                {botLinearErrorMessage(step.error, hostName)}
              </p>
            ) : null}
            <DialogFooter>
              {closeButton}
              <Button autoFocus onClick={() => void signIn.start({ bot })}>
                {t('bots.linear.connect.button', 'Connect Linear')}
                <ExternalLink />
              </Button>
            </DialogFooter>
          </div>
        )
      case 'pick':
        return (
          <div className="space-y-4">
            {tripError}
            <ConnectorWorkspacePicker
              prompt={t('bots.linear.connect.pick', 'Choose a Linear workspace.')}
              workspaces={step.workspaces.map((entry) => ({
                key: entry.workspaceId,
                icon: <LinearIcon />,
                label: linearWorkspaceLabel(entry.name, entry.urlKey),
                onPick: () => setPicked(entry.workspaceId)
              }))}
              another={
                <Button variant="ghost" onClick={addAnotherWorkspace}>
                  {anotherWorkspaceLabel}
                  <ExternalLink />
                </Button>
              }
            />
          </div>
        )
      case 'waiting':
        return (
          <ConnectWaiting
            label={t('bots.linear.connect.waiting', 'Finish signing in to Linear in your browser…')}
            onCancel={() => cancelConnectorConnect(bot.hostId, 'linear')}
            // Linear never returns from its own error page, so Orca can only say what it likely is.
            help={t(
              'bots.linear.connect.stuck',
              'Stuck on a Linear page that says “Could not find OAuth client”? Orca’s Linear app isn’t open to this workspace yet. An admin of the workspace that owns the app must make it public.'
            )}
          />
        )
      case 'needs-admin':
        return (
          <div className="space-y-4">
            {anotherWorkspace}
            <p className="break-words text-sm text-muted-foreground">
              {t(
                'bots.linear.setup.install',
                'Orca is not installed in {{workspace}} yet. A Linear admin installs it once for everyone.',
                { workspace: linearWorkspaceLabel(step.workspace.name, step.workspace.urlKey) }
              )}
            </p>
            {linearAwait === 'checking' ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('bots.linear.setup.installing', 'Waiting for the install…')}
              </p>
            ) : linearAwait === 'unchanged' ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t('bots.linear.setup.noInstallYet', 'Orca isn’t installed there yet.')}
              </p>
            ) : null}
            {/* The label lives in the text above: inside a button, a long one pushed this off the dialog. */}
            <DialogFooter>
              {closeButton}
              <Button
                variant="outline"
                onClick={() => {
                  void window.api.ui.writeClipboardText(step.installUrl).then(() => {
                    void awaitLinearChange(bot.hostId)
                    toast.success(t('bots.linear.setup.copied', 'Link copied.'))
                  })
                }}
              >
                <Copy />
                {t('bots.linear.setup.copyForAdmin', 'Copy admin link')}
              </Button>
            </DialogFooter>
          </div>
        )
      case 'turn-on':
        return (
          <div className="space-y-4">
            {anotherWorkspace}
            <div>
              <LinkedPeople
                bot={bot}
                linear={{
                  workspaceId: step.workspace.workspaceId,
                  workspaceName: step.workspace.name,
                  urlKey: step.workspace.urlKey
                }}
              />
            </div>
            <DialogFooter>
              {on ? null : closeButton}
              {on ? (
                <Button autoFocus onClick={onClose}>
                  {t('bots.linear.setup.finish', 'Done')}
                </Button>
              ) : (
                <Button autoFocus disabled={saving} onClick={() => void turnOn(step.workspace)}>
                  {t('bots.linear.connect.turnOn', 'Turn on {{name}}', { name: bot.name })}
                </Button>
              )}
            </DialogFooter>
          </div>
        )
      case 'done':
        // Who can ask is edited later in the Linear connector's settings (BotLinearCard), not here.
        return (
          <div className="space-y-4">
            <ConnectorTryIt
              heading={t('bots.linear.setup.tryIt', 'Try it on any Linear issue')}
              ways={[
                { key: 'mention', shown: linearMention(bot), copy: linearMention(bot) },
                {
                  key: 'label',
                  lead: t('bots.linear.setup.orLabel', 'or add the label'),
                  shown: linearLabel(bot),
                  copy: linearLabel(bot)
                }
              ]}
              note={linearActsAs(hostName)}
            />
            <DialogFooter>
              <Button autoFocus onClick={onClose}>
                {t('bots.linear.setup.finish', 'Done')}
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
