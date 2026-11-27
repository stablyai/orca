// @protected-copy: drawn inside the security-surface setup dialog
// The steps of "Add <bot> to Discord" inside its dialog: make the bot's own Discord application and
// paste its token, add that bot to a server, then try it.
import React, { useEffect, useId, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { DiscordIcon } from '@/components/icons/DiscordIcon'
import {
  awaitDiscordChange,
  botDiscordState,
  refreshBotDiscord,
  stopAwaitingDiscord,
  useBotDiscordHost,
  useDiscordAwait
} from '@/lib/bot-discord-state'
import { botDiscordCalls } from '@/lib/bot-connector-host-calls'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { BotHostSignInButton } from '../BotHostSignInButton'
import { useBotHostLabel } from '../use-bot-host-label'
import { discordMembersOf, type Bot } from '../../../../../shared/bot-types'
import {
  BOT_DISCORD_OFF,
  DISCORD_DEVELOPER_PORTAL_URL,
  discordBotToken,
  discordInviteUrl
} from '../../../../../shared/connector-bot-discord-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { ConnectWaiting, ConnectorSetupHeader, connectorSetupFor } from '../connector-connect-parts'
import { ConnectorTryIt } from '../ConnectorTryIt'
import { OrcaCloudSignInDialogBody, orcaCloudSignInReason } from '../orca-cloud-sign-in'
import { botDiscordErrorMessage, discordMention } from './bot-discord-copy'
import { botDiscordSetupStep } from './discord-setup-step'

export const DISCORD = { id: 'discord', Icon: DiscordIcon } as const

export function BotDiscordSetupFlow({
  bot,
  guildId,
  title,
  onClose
}: {
  bot: Bot
  /** A server row being repaired; none adds the bot to Discord, or to another server. */
  guildId: string | undefined
  title: string
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const view = useBotDiscordHost(bot.hostId)
  const waiting = useDiscordAwait(bot.hostId)
  const [newToken, setNewToken] = useState(false)
  const [known, setKnown] = useState<readonly string[] | null>(null)
  const state = botDiscordState(view, bot.id)
  // The servers it was in when this setup began, so the one it joins next reads as done.
  useEffect(() => {
    if (known === null && view.status === 'ready') {
      setKnown(state.state === 'ready' ? state.guilds.map((guild) => guild.guildId) : [])
    }
  }, [known, view.status, state])
  // Waiting on Discord stops with the setup.
  useEffect(() => () => stopAwaitingDiscord(bot.hostId), [bot.hostId])
  const step = botDiscordSetupStep(view, bot.id, { newToken, known, target: guildId ?? null })
  const closeButton = (
    <Button variant="ghost" onClick={onClose}>
      {t('bots.discord.setup.close', 'Close')}
    </Button>
  )

  if (step.kind === 'failed' && step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return (
      <OrcaCloudSignInDialogBody
        title={title}
        reason={orcaCloudSignInReason('discord')}
        onCancel={onClose}
        onSignedIn={() => refreshBotDiscord(bot.hostId)}
      />
    )
  }
  const header = (
    <ConnectorSetupHeader
      connector={DISCORD}
      title={
        step.kind === 'done'
          ? t('bots.discord.setup.isOn', '{{name}} is on Discord', { name: bot.name })
          : title
      }
      intro={connectorSetupFor(bot, hostName)}
      done={step.kind === 'done'}
    />
  )
  const body = ((): React.JSX.Element => {
    switch (step.kind) {
      case 'checking':
        return (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('bots.discord.setup.checking', 'Checking Discord…')}
          </p>
        )
      case 'failed':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {botDiscordErrorMessage(step.code, hostName)}
            </p>
            <DialogFooter>
              {closeButton}
              {step.code === BOT_SLACK_DESKTOP_ERRORS.signedOut ? (
                <BotHostSignInButton bot={bot} onClose={onClose} />
              ) : step.code === BOT_DISCORD_OFF ? null : (
                <Button onClick={() => void refreshBotDiscord(bot.hostId)}>
                  {t('bots.discord.setup.retry', 'Try again')}
                </Button>
              )}
            </DialogFooter>
          </div>
        )
      case 'token':
        return (
          <DiscordTokenStep
            bot={bot}
            broken={step.broken}
            closeButton={closeButton}
            onSaved={() => {
              setNewToken(false)
              // Servers a new application is already in count as joined.
              setKnown([])
            }}
          />
        )
      case 'invite':
        return (
          <div className="space-y-4">
            <p className="text-sm">
              {t(
                'bots.discord.invite.text',
                'Add {{botName}} to a server you manage. Discord asks which one, and what it may do there.',
                { botName: step.botName || bot.name }
              )}
            </p>
            {waiting === 'checking' ? (
              <ConnectWaiting
                label={t('bots.discord.invite.waiting', 'Finish adding it in Discord…')}
                onCancel={() => stopAwaitingDiscord(bot.hostId)}
              />
            ) : waiting === 'unchanged' ? (
              <p role="alert" className="text-sm text-muted-foreground">
                {t('bots.discord.invite.unchanged', 'Discord hasn’t added it to a server yet.')}
              </p>
            ) : null}
            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={() => setNewToken(true)}>
                {t('bots.discord.invite.newToken', 'Use another token')}
              </Button>
              <div className="flex gap-2">
                {closeButton}
                <Button
                  autoFocus
                  onClick={() => {
                    openAppHttpLink(discordInviteUrl(step.applicationId))
                    awaitDiscordChange(bot.hostId)
                  }}
                >
                  {t('bots.discord.invite.button', 'Add to a server')}
                  <ExternalLink />
                </Button>
              </div>
            </DialogFooter>
          </div>
        )
      case 'done': {
        const mention = discordMention(bot, step.botName)
        return (
          <div className="space-y-4">
            <ConnectorTryIt
              heading={t('bots.discord.setup.tryIt', 'Try it in {{server}}', {
                server: step.guilds[0].name
              })}
              ways={[{ key: 'mention', shown: mention, copy: mention }]}
              note={discordAccessNote(bot, step.guilds[0].guildId, t)}
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() =>
                  openAppHttpLink(`https://discord.com/channels/${step.guilds[0].guildId}`)
                }
              >
                {t('bots.discord.setup.openDiscord', 'Open Discord')}
                <ExternalLink />
              </Button>
              <Button autoFocus onClick={onClose}>
                {t('bots.discord.setup.finish', 'Done')}
              </Button>
            </DialogFooter>
          </div>
        )
      }
    }
  })()
  return (
    <>
      {header}
      {body}
    </>
  )
}

// Shown by name up to this many; the rest as a count.
const ACCESS_NAMES_SHOWN = 4

/** Who can ask the bot in that server as its record stands: a repaired server keeps its people and roles. */
function discordAccessNote(bot: Bot, guildId: string, t: Translate): string {
  const guild = bot.discord?.guilds.find((entry) => entry.guildId === guildId)
  const names = [
    ...discordMembersOf(bot.members, guildId).map((member) => member.name || member.id),
    ...(guild?.roles ?? []).map((role) =>
      t('bots.discord.setup.anyoneWithRole', 'anyone with {{role}}', { role: role.name || role.id })
    )
  ]
  if (names.length === 0) {
    return t(
      'bots.discord.setup.whoNote',
      'Only you can ask it until you add people or roles under Discord on its page.'
    )
  }
  const shown = names.slice(0, ACCESS_NAMES_SHOWN).join(', ')
  return names.length > ACCESS_NAMES_SHOWN
    ? t(
        'bots.discord.setup.whoNoteMore',
        'Who can ask it here: you, {{names}} and {{count}} more.',
        {
          names: shown,
          count: names.length - ACCESS_NAMES_SHOWN
        }
      )
    : t('bots.discord.setup.whoNoteListed', 'Who can ask it here: you, {{names}}.', {
        names: shown
      })
}

/** Make the application in Discord's Developer Portal, then paste its bot token; it is cleared once sent. */
function DiscordTokenStep({
  bot,
  broken,
  closeButton,
  onSaved
}: {
  bot: Bot
  broken: string | null
  closeButton: React.ReactNode
  onSaved: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const inputId = useId()
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(
    broken === 'token_revoked' ? 'discord_token_invalid' : null
  )
  const pasted = discordBotToken(token)
  const save = async (): Promise<void> => {
    if (pasted === null) {
      return
    }
    setSaving(true)
    setError(null)
    setToken('')
    const result = await botDiscordCalls(bot.hostId).setUp({ botId: bot.id, token: pasted })
    if (result.ok) {
      onSaved()
      await refreshBotDiscord(bot.hostId)
    } else {
      setError(result.error)
    }
    setSaving(false)
  }
  const steps = [
    t(
      'bots.discord.token.stepApp',
      'In Discord’s Developer Portal, choose New Application and name it {{name}}.',
      { name: bot.name }
    ),
    t('bots.discord.token.stepBot', 'Open Bot, choose Reset Token, and copy the token.'),
    t(
      'bots.discord.token.stepPaste',
      'Paste it below. Orca Cloud keeps it encrypted and never shows it again.'
    )
  ]
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <p className="text-sm">
        {t(
          'bots.discord.token.intro',
          '{{name}} gets its own bot in Discord. Discord makes bots only in its Developer Portal:',
          { name: bot.name }
        )}
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {steps.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openAppHttpLink(DISCORD_DEVELOPER_PORTAL_URL)}
      >
        {t('bots.discord.token.openPortal', 'Open the Developer Portal')}
        <ExternalLink />
      </Button>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{t('bots.discord.token.label', 'Bot token')}</Label>
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          disabled={saving}
          onChange={(event) => setToken(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {botDiscordErrorMessage(error, hostName)}
          </p>
        ) : token.trim() && pasted === null ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'bots.discord.token.notToken',
              'That isn’t a bot token. Copy it from Bot, not the application ID or client secret.'
            )}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        {closeButton}
        <Button type="submit" disabled={saving || pasted === null}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {t('bots.discord.token.save', 'Turn on {{name}}', { name: bot.name })}
        </Button>
      </DialogFooter>
    </form>
  )
}
