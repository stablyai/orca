// @protected-copy: drawn inside the security-surface setup dialog
// The steps of "Add <bot> to Zoho Cliq" inside its dialog: sign in to Zoho, pick an organization,
// turn on (Orca Cloud creates the bot's own Cliq bot there).
import React, { useEffect, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { CliqIcon } from '@/components/icons/CliqIcon'
import { refreshBotCliq, useBotCliq } from '@/lib/bot-cliq-state'
import { cancelConnectorConnect, useResumeAfterConnect } from '@/lib/connector-connect-state'
import { botCliqCalls } from '@/lib/bot-connector-host-calls'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { BotHostSignInButton } from '../BotHostSignInButton'
import { useBotHostLabel } from '../use-bot-host-label'
import { botCliqBots, type Bot } from '../../../../../shared/bot-types'
import { BOT_CLIQ_OFF, cliqWebUrl } from '../../../../../shared/connector-bot-cliq-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import {
  ConnectWaiting,
  ConnectorMoreLink,
  ConnectorSetupHeader,
  ConnectorWorkspacePicker,
  SignedInAs,
  connectorSetupFor
} from '../connector-connect-parts'
import { ConnectorTryIt } from '../ConnectorTryIt'
import type { useSetupStepAside } from '../connector-setup-surface'
import { botCliqErrorMessage, cliqMention } from './bot-cliq-copy'
import { botCliqSetupStep, type CliqSignIn } from './cliq-setup-step'
import { OrcaCloudSignInDialogBody, orcaCloudSignInReason } from '../orca-cloud-sign-in'

export const CLIQ = { id: 'cliq', Icon: CliqIcon } as const

/** The setup's own sign-in trips, so only those carry it on (useResumeAfterConnect). */
function cliqSetupOwner(bot: Bot): string {
  return `cliq-setup:${bot.hostId}:${bot.id}`
}

export function BotCliqSetupFlow({
  bot,
  orgId,
  on,
  title,
  onClose,
  aside
}: {
  bot: Bot
  orgId: string | undefined
  /** Already on in `orgId`: setting up again repairs its Cliq bot. */
  on: boolean
  title: string
  onClose: () => void
  /** Steps aside while Zoho's page is open in Orca's browser, behind the dialog. */
  aside: ReturnType<typeof useSetupStepAside>
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const [done, setDone] = useState(false)
  const [doneIn, setDoneIn] = useState<CliqSignIn | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [turnOnError, setTurnOnError] = useState<string | null>(null)
  const view = useBotCliq(bot.hostId)
  // A sign-in this setup starts was for turning the bot on: once it lands in one organization, the
  // bot turns on there with no second click.
  const signIn = useResumeAfterConnect(bot.hostId, 'cliq', {
    owner: cliqSetupOwner(bot),
    onStepAside: aside.stepAside,
    away: aside.away,
    onLinked: () => {
      if (step.kind === 'turn-on' && !on) {
        void turnOn(step.org)
      }
    }
  })
  const connect = signIn.connect
  const { away, comeBack } = aside
  const signInEnded = connect.status !== 'waiting'
  useEffect(() => {
    if (away && signInEnded) {
      comeBack()
    }
  }, [away, signInEnded, comeBack])
  const step = botCliqSetupStep(view, connect, {
    orgId: picked ?? orgId ?? null,
    done,
    taken: orgId === undefined ? botCliqBots(bot).map((entry) => entry.orgId) : []
  })

  const turnOn = async (org: CliqSignIn): Promise<void> => {
    setSaving(true)
    setTurnOnError(null)
    const result = await botCliqCalls(bot.hostId).setUp({ botId: bot.id, orgId: org.orgId })
    setSaving(false)
    if (!result.ok) {
      setTurnOnError(result.error)
      return
    }
    setDoneIn(org)
    setDone(true)
  }

  const closeButton = (
    <Button variant="ghost" onClick={onClose}>
      {t('bots.cliq.setup.close', 'Close')}
    </Button>
  )
  // Zoho's account picker again, to sign in to another organization; the others stay signed in.
  const addAnotherOrg = (): void => void signIn.start({ switchAccount: true, bot })
  const anotherOrgLabel = t('bots.cliq.connect.another', 'Use another organization')
  const tripError =
    connect.status === 'failed' ? (
      <p role="alert" className="text-sm text-destructive">
        {botCliqErrorMessage(connect.error, hostName)}
      </p>
    ) : null
  const signedIn = (org: CliqSignIn): React.JSX.Element => (
    <SignedInAs
      who={t('bots.cliq.connect.who', '{{name}} in {{org}}', {
        name: org.userName || org.userId,
        org: org.name
      })}
      onNotYou={addAnotherOrg}
    />
  )

  if (step.kind === 'failed' && step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return (
      <OrcaCloudSignInDialogBody
        title={title}
        reason={orcaCloudSignInReason('cliq')}
        onCancel={onClose}
        onSignedIn={() => refreshBotCliq(bot.hostId)}
      />
    )
  }
  const signedInAt =
    step.kind === 'turn-on' || step.kind === 'expired'
      ? step.org
      : step.kind === 'done'
        ? doneIn
        : null
  const header = (
    <ConnectorSetupHeader
      connector={CLIQ}
      title={
        step.kind === 'done'
          ? t('bots.cliq.setup.isOn', '{{name}} is on Zoho Cliq', { name: bot.name })
          : signedInAt
            ? title
            : t('bots.cliq.setup.connectTitle', 'Connect Zoho Cliq')
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
            {t('bots.cliq.setup.checking', 'Checking Zoho Cliq…')}
          </p>
        )
      case 'failed':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {botCliqErrorMessage(step.code, hostName)}
            </p>
            <DialogFooter>
              {closeButton}
              {step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut ? (
                <BotHostSignInButton bot={bot} onClose={onClose} />
              ) : step.code === BOT_CLIQ_OFF ? null : (
                <Button onClick={() => void refreshBotCliq(bot.hostId)}>
                  {t('bots.cliq.setup.retry', 'Try again')}
                </Button>
              )}
            </DialogFooter>
          </div>
        )
      case 'connect':
        return (
          <div className="space-y-4">
            <p className="text-sm">
              {t(
                'bots.cliq.connect.pickOrg',
                'Sign in to Zoho and pick the Cliq organization {{name}} works in. Orca creates a Cliq bot named {{name}} there, as you.',
                { name: bot.name }
              )}
            </p>
            {step.error ? (
              <p role="alert" className="text-sm text-destructive">
                {botCliqErrorMessage(step.error, hostName)}
              </p>
            ) : null}
            <DialogFooter>
              {closeButton}
              <Button autoFocus onClick={() => void signIn.start({ bot })}>
                {t('bots.cliq.connect.button', 'Connect Zoho Cliq')}
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
              prompt={t('bots.cliq.connect.pick', 'Choose a Cliq organization.')}
              workspaces={step.orgs.map((entry) => ({
                key: entry.orgId,
                icon: <CliqIcon />,
                label: entry.name,
                onPick: () => setPicked(entry.orgId)
              }))}
              another={
                <Button variant="ghost" onClick={addAnotherOrg}>
                  {anotherOrgLabel}
                  <ExternalLink />
                </Button>
              }
            />
          </div>
        )
      case 'waiting':
        return (
          <ConnectWaiting
            label={t('bots.cliq.connect.waiting', 'Finish signing in to Zoho in your browser…')}
            onCancel={() => cancelConnectorConnect(bot.hostId, 'cliq')}
          />
        )
      case 'expired':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {botCliqErrorMessage('cliq_grant_expired', hostName)}
            </p>
            <DialogFooter>
              {closeButton}
              <Button autoFocus onClick={() => void signIn.start({ bot })}>
                {t('bots.cliq.connect.again', 'Sign in again')}
                <ExternalLink />
              </Button>
            </DialogFooter>
          </div>
        )
      case 'turn-on':
        return (
          <div className="space-y-4">
            <div className="space-y-1">
              <ConnectorMoreLink more={{ label: anotherOrgLabel, onClick: addAnotherOrg }} />
              {tripError}
            </div>
            {turnOnError ? (
              <p role="alert" className="text-sm text-destructive">
                {botCliqErrorMessage(turnOnError, hostName)}
              </p>
            ) : null}
            <DialogFooter>
              {closeButton}
              <Button autoFocus disabled={saving} onClick={() => void turnOn(step.org)}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                {on
                  ? t('bots.cliq.setup.repair', 'Set up again')
                  : t('bots.cliq.connect.turnOn', 'Turn on {{name}}', { name: bot.name })}
              </Button>
            </DialogFooter>
          </div>
        )
      case 'done':
        return (
          <div className="space-y-4">
            <ConnectorTryIt
              heading={t('bots.cliq.setup.tryIt', 'Try it in any Cliq channel')}
              ways={[{ key: 'mention', shown: cliqMention(bot), copy: cliqMention(bot) }]}
              note={t(
                'bots.cliq.setup.dmNote',
                'To message it directly, open {{name}} under Bots in Cliq first.',
                { name: bot.name }
              )}
            />
            <DialogFooter>
              {doneIn ? (
                <Button
                  variant="outline"
                  onClick={() => openAppHttpLink(cliqWebUrl(doneIn.dataCenter))}
                >
                  {t('bots.cliq.setup.openCliq', 'Open Cliq')}
                  <ExternalLink />
                </Button>
              ) : null}
              <Button autoFocus onClick={onClose}>
                {t('bots.cliq.setup.finish', 'Done')}
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
