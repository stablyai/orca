// @protected-copy: drawn inside the security-surface setup dialog
import React, { useEffect, useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { SlackIcon } from '@/components/icons/SlackIcon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'
import { signedOutHere } from '../bot-host-copy'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { botSlackErrorMessage } from './bot-slack-copy'
import { readBotSlack, slackTeamState } from '@/lib/bot-slack-state'
import { BotSlackPostAs } from './BotSlackPostAs'
import { SlackTryItPreview } from './SlackTryItPreview'
import {
  ConnectorSetupHeader,
  ConnectorWorkspacePicker,
  connectorSetupFor
} from '../connector-connect-parts'
import { SlackOpenAppButton } from './SlackOpenAppButton'
import { SlackConfigTokenForm } from './SlackConfigTokenForm'
import { SlackSetupPrepare } from './SlackSetupPrepare'
import { SlackTeamName } from './SlackWorkspacesSettings'
import { BotHostSignInButton } from '../BotHostSignInButton'
import { ConnectorSetupDialog, useSetupStepAside } from '../connector-setup-surface'
import { forgetOpenedSlackPages, useBotSlackSetup } from './use-bot-slack-setup'
import { useSlackHandOffOffer } from './use-slack-hand-off-offer'
import { SlackCopyLink, SlackHandOffConfirm, SlackHandOffLines } from './slack-hand-off-parts'
import { useBotHostLabel } from '../use-bot-host-label'
import {
  SlackOneLineIntro,
  SlackReconnectStep,
  slackReconnectOffer,
  slackReconnectTitle
} from './SlackReconnectStep'
import {
  OrcaCloudSignInDialogBody,
  OrcaCloudSignInGate,
  orcaCloudSignInReason
} from '../orca-cloud-sign-in'

const SLACK = { id: 'slack', Icon: SlackIcon } as const

function BotSlackSetupFlow({
  bot,
  teamId,
  title,
  onClose,
  aside
}: {
  bot: Bot
  teamId: string | undefined
  /** The dialog's title while setting up; installed says the bot is in Slack. */
  title: string
  onClose: () => void
  aside: ReturnType<typeof useSetupStepAside>
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const { step, retry, setUp, handOff, submitToken, pasteToken, approve, copyLink } =
    useBotSlackSetup(bot, teamId, aside.stepAside)
  const offer = useSlackHandOffOffer(bot, step)
  // Back from Slack's page in Orca's browser once the install ends, or needs the owner. Stepping aside
  // mounts this flow anew, which checks again before it waits again: that is not an end.
  const settled =
    step.kind === 'installed' ||
    step.kind === 'prepare' ||
    step.kind === 'uncertain' ||
    step.kind === 'failed' ||
    step.kind === 'token' ||
    step.kind === 'expired' ||
    step.kind === 'other-user'
  const { away, comeBack } = aside
  useEffect(() => {
    if (away && settled) {
      comeBack()
    }
  }, [away, settled, comeBack])
  const ownEmail = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.email ?? null)
  const [checkedSlack, setCheckedSlack] = useState(false)
  const checkboxId = useId()

  // This computer's sign-in lapsed while open: the same ask, then setup again. A server's failed
  // step signs in that server instead.
  if (step.kind === 'failed' && signedOutHere(step, hostName)) {
    return (
      <OrcaCloudSignInDialogBody
        title={title}
        reason={orcaCloudSignInReason('slack')}
        onCancel={onClose}
        onSignedIn={retry}
      />
    )
  }
  const installed = step.kind === 'installed'
  // The setup hook follows the bot's Slack, so this read is current on every render.
  const view = readBotSlack(bot)
  const installedState =
    installed && view.status === 'ready' ? slackTeamState(view.slack, step.teamId) : null
  // A lapsed token: this desktop's own one first, for the one workspace it lapsed in.
  const reconnecting = step.kind === 'token' && step.reconnect
  const reconnectOffer = reconnecting ? slackReconnectOffer(offer, hostName) : null
  const intro = installed ? '' : connectorSetupFor(bot, hostName)
  // Progressive disclosure: until installed, the header names only the bot; how to ask waits for Done.
  const header = (
    <ConnectorSetupHeader
      connector={SLACK}
      title={
        installed
          ? t('bots.slack.setup.isIn', '{{name}} is in Slack', { name: bot.name })
          : reconnecting
            ? slackReconnectTitle(t, reconnectOffer !== null)
            : title
      }
      intro={intro}
      line={
        installedState?.state === 'installed' ? (
          t('bots.slack.connection.installedBy', 'installed by {{installer}}', {
            installer: installedState.installerName ?? installedState.installerUserId
          })
        ) : reconnecting ? (
          <SlackOneLineIntro text={intro} />
        ) : undefined
      }
      done={installed}
    />
  )
  const body = ((): React.JSX.Element => {
    switch (step.kind) {
      case 'checking':
      case 'setting-up': {
        const status = (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {step.kind === 'checking'
              ? t('bots.slack.setup.checking', 'Checking Slack…')
              : t('bots.slack.setup.settingUp', 'Setting up your Slack app…')}
          </p>
        )
        return step.kind === 'setting-up' && step.handOff && ownEmail && hostName ? (
          <div className="space-y-4">
            <SlackHandOffConfirm email={ownEmail} host={hostName} />
            {status}
          </div>
        ) : (
          status
        )
      }
      case 'prepare':
        return (
          <SlackSetupPrepare
            update={step.update}
            onContinue={() => void setUp(step.teamId)}
            onClose={onClose}
          />
        )
      case 'pick':
        return (
          <ConnectorWorkspacePicker
            prompt={t('bots.slack.setup.pick', 'Choose a Slack workspace.')}
            workspaces={step.teamIds.map((pickTeamId) => ({
              key: pickTeamId,
              icon: <SlackIcon />,
              label: <SlackTeamName hostId={bot.hostId} teamId={pickTeamId} />,
              onPick: () => void setUp(pickTeamId)
            }))}
            another={
              <Button variant="ghost" onClick={pasteToken}>
                {t('bots.slack.setup.another', 'Connect another workspace')}
              </Button>
            }
          />
        )
      case 'token':
        return step.reconnect ? (
          <SlackReconnectStep
            bot={bot}
            hostName={hostName}
            offer={reconnectOffer}
            mine={step.mine === true}
            ownEmail={ownEmail}
            error={step.error}
            onUse={(useTeamId) => void handOff(useTeamId)}
            onSubmit={(token) => void submitToken(token)}
            onCancel={onClose}
          />
        ) : (
          <SlackConfigTokenForm
            hostId={bot.hostId}
            aside={
              offer ? (
                <SlackHandOffLines
                  email={offer.email}
                  teamIds={offer.teamIds}
                  onUse={(useTeamId) => void handOff(useTeamId)}
                />
              ) : null
            }
            submitLabel={t('bots.slack.setup.create', 'Create Slack app')}
            busy={false}
            error={step.error}
            onSubmit={(token) => void submitToken(token)}
          />
        )
      case 'ready':
        return (
          <div className="space-y-4">
            <p className="text-sm">
              {t(
                'bots.slack.setup.ready',
                'Your Slack app is ready. Approve it in Slack to finish.'
              )}
            </p>
            <Button autoFocus className="w-full" onClick={approve}>
              {t('bots.slack.setup.approve', 'Approve in Slack')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('bots.slack.setup.otherBrowser', 'Approving in another browser?')}{' '}
              <SlackCopyLink link={step.link} copied={false} onCopy={copyLink} />
            </p>
          </div>
        )
      case 'waiting':
        return (
          <div className="space-y-4">
            <p role="status" className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('bots.slack.setup.waiting', 'Waiting for Slack…')}
            </p>
            {hostName && step.link ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'bots.slack.setup.approveAsYourself',
                    'Approve in Slack as yourself. Approving in another browser?'
                  )}{' '}
                  <SlackCopyLink link={step.link} copied={step.copied} onCopy={copyLink} />
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'bots.slack.setup.waitingAdmin',
                    'If your workspace needs an admin to approve new apps, {{name}} joins once they do. If they decline, Install again reuses the same app.',
                    { name: bot.name }
                  )}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t(
                  'bots.slack.setup.waitingDetail',
                  'Finish in Slack. If your workspace needs an admin to approve new apps, {{name}} joins once they do. If they decline, Install again reuses the same app.',
                  { name: bot.name }
                )}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t('bots.slack.setup.close', 'Close')}
              </Button>
              <Button variant="outline" onClick={() => void setUp(step.teamId)}>
                {t('bots.slack.setup.installAgain', 'Install again')}
              </Button>
            </DialogFooter>
          </div>
        )
      case 'expired':
      case 'other-user':
        return (
          <div className="space-y-4">
            {step.kind === 'expired' ? (
              <p className="text-sm">
                {t('bots.slack.setup.expired', 'The install link expired.')}
              </p>
            ) : (
              <p className="text-sm text-destructive">
                {t(
                  'bots.slack.setup.otherUser',
                  'Another Slack account approved it. Get a new link and approve as yourself.'
                )}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t('bots.slack.setup.close', 'Close')}
              </Button>
              <Button autoFocus onClick={() => void setUp(step.teamId)}>
                {t('bots.slack.setup.newLink', 'Get a new link')}
              </Button>
            </DialogFooter>
          </div>
        )
      case 'uncertain':
        return (
          <div className="space-y-4">
            <p className="text-sm">
              {t(
                'bots.slack.setup.uncertain',
                'Slack may have created an app named {{name}} that Orca cannot use. Delete it in Slack app settings if it is there, then set up again.',
                { name: bot.name }
              )}
            </p>
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={checkedSlack}
                onCheckedChange={(checked) => setCheckedSlack(checked === true)}
              />
              <Label htmlFor={checkboxId}>
                {t(
                  'bots.slack.setup.uncertainChecked',
                  'I checked Slack: there is no such app, or I deleted it'
                )}
              </Label>
            </div>
            <DialogFooter>
              <Button disabled={!checkedSlack} onClick={() => void setUp(step.teamId)}>
                {t('bots.slack.setup.again', 'Set up again')}
              </Button>
            </DialogFooter>
          </div>
        )
      case 'installed':
        // Who can ask is edited later in the Slack connector's settings (BotSlackCard), not here.
        // Post as stays: this install's link applies the pick at once, later it needs Slack's approval.
        return (
          <div className="space-y-4">
            <SlackTryItPreview
              bot={bot}
              asker={
                installedState?.state === 'installed' ? installedState.installerName : undefined
              }
            />
            {installedState?.state === 'installed' ? (
              <BotSlackPostAs bot={bot} slack={installedState} setupState={step.setupState} />
            ) : null}
            <DialogFooter>
              <SlackOpenAppButton bot={bot} slack={installedState} onOpenedInOrca={onClose} />
              <Button autoFocus onClick={onClose}>
                {t('bots.slack.setup.done', 'Done')}
              </Button>
            </DialogFooter>
          </div>
        )
      case 'failed':
        return (
          <div className="space-y-4">
            <p className="text-sm text-destructive">{botSlackErrorMessage(step.code, hostName)}</p>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t('bots.slack.setup.close', 'Close')}
              </Button>
              {/* Retrying cannot sign anyone in; send them where they can. */}
              {step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut ? (
                <BotHostSignInButton bot={bot} onClose={onClose} />
              ) : (
                <Button onClick={() => void retry()}>
                  {t('bots.slack.setup.retry', 'Try again')}
                </Button>
              )}
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

/** "Add connector → Slack" for one bot: the first bot in a workspace pastes a token, later ones are one click. */
export function BotSlackSetupDialog({
  bot,
  teamId,
  open,
  onOpenChange
}: {
  bot: Bot
  /** A workspace the bot is already in; none adds it to Slack, or to another workspace. */
  teamId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const close = (): void => onOpenChange(false)
  // A new open of the dialog is a fresh attempt, which opens Slack's page again.
  useEffect(() => {
    if (!open) {
      forgetOpenedSlackPages(bot)
    }
    return () => forgetOpenedSlackPages(bot)
  }, [open, bot])
  const title =
    teamId === undefined && botSlackApps(bot).length > 0
      ? t('bots.slack.setup.connectAnother', 'Connect another Slack workspace')
      : t('bots.slack.setup.connect', 'Connect Slack')
  // Away while Slack's page is in Orca's browser; the flow says when to come back.
  const aside = useSetupStepAside()
  return (
    <ConnectorSetupDialog
      open={open}
      onOpenChange={onOpenChange}
      aside={aside}
      connector={SLACK}
      service="Slack"
      botName={bot.name}
      waiting
    >
      <OrcaCloudSignInGate
        hostId={bot.hostId}
        title={title}
        reason={orcaCloudSignInReason('slack')}
        onCancel={close}
      >
        <BotSlackSetupFlow bot={bot} teamId={teamId} title={title} onClose={close} aside={aside} />
      </OrcaCloudSignInGate>
    </ConnectorSetupDialog>
  )
}
