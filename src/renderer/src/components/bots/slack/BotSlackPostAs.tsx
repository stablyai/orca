// "When you reply to a Slack thread from Orca, it posts as <Name> ⌄": who a message typed at the bot's computer
// posts as in its Slack threads. The picker shows each choice as the Slack post it makes. Right after
// install the pick applies at once; later, a change waits on whoever set the bot's Slack up approving
// it in Slack, and the line keeps the old choice until then.
import React, { useState } from 'react'
import { Trans } from 'react-i18next'
import { Check, ChevronDown, Laptop } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import { refreshBotSlack } from '@/lib/bot-slack-state'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  ConnectorBotSlackState,
  SlackPostAs
} from '../../../../../shared/connector-bot-slack-contract'
import { ConnectorAvatar } from '@/components/ConnectorAvatar'
import { useBotHostLabel } from '../use-bot-host-label'
import { botSlackErrorMessage } from './bot-slack-copy'
import { openSlackApprovalHere } from './slack-page-here'
import { SlackPersonPlaceholder } from './SlackPersonPlaceholder'

type Installed = Extract<ConnectorBotSlackState, { state: 'installed' }>

// Slack's own message look, small: its fixed colours, not Orca's, so the preview reads as Slack.
const SLACK_POST =
  'bg-white text-[#1d1c1d] dark:bg-[#1a1d21] dark:text-[#d1d2d3] [--slack-muted:#616061] dark:[--slack-muted:#ababad]'
const SAMPLE_TIME = new Date(2026, 0, 1, 9, 41)

/** What a choice posts under: the person's name and Slack photo, or the computer's name. */
type Poster = { name: string; avatar: React.ReactNode }

export function BotSlackPostAs({
  bot,
  slack,
  setupState,
  className
}: {
  bot: Bot
  slack: Installed
  /** The after-install pick's install link state: its pick applies at once. */
  setupState?: string
  /** E.g. the card's inset, to line up under its Who can ask rows. */
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hostLabel = useBotHostLabel(bot.hostId)
  const hostAccount = useBotHostOrcaAccount(bot.hostId)
  const [open, setOpen] = useState(false)
  // The panel's pick, before it is sent for approval; null once it matches what is posted as.
  const [asked, setAsked] = useState<SlackPostAs | null>(null)
  // The dialog's pick, shown while it applies.
  const [applying, setApplying] = useState<SlackPostAs | null>(null)
  const [busy, setBusy] = useState(false)
  if (!slack.postAs) {
    return null
  }
  const current = applying ?? slack.postAs
  const waiting = [asked, slack.postAsPending].find(
    (choice): choice is SlackPostAs =>
      choice !== undefined && choice !== null && choice !== slack.postAs
  )
  const calls = botSlackCalls(bot.hostId)
  const teamId = slack.teamId

  const person: Poster = {
    name:
      slack.poster?.name ||
      hostAccount?.displayName ||
      hostAccount?.email?.split('@')[0] ||
      t('bots.slack.postAs.orcaUser', 'Orca user'),
    avatar: (
      <ConnectorAvatar
        avatarUrl={slack.poster?.avatarUrl}
        name=""
        className="size-full rounded-none"
        fallback={<SlackPersonPlaceholder />}
      />
    )
  }
  const computer: Poster = {
    name: slack.computerName || hostLabel || t('bots.slack.postAs.thisComputer', 'This computer'),
    avatar: (
      <span className="flex size-full items-center justify-center bg-muted text-muted-foreground">
        <Laptop className="size-4" />
      </span>
    )
  }
  const posters: Record<SlackPostAs, Poster> = { person, computer }

  const failed = (error: string): void => {
    toast.error(botSlackErrorMessage(error, hostLabel))
  }

  const requestApproval = async (choice: SlackPostAs): Promise<void> => {
    setBusy(true)
    const result = await calls.setPostAs({ botId: bot.id, teamId, postAs: choice })
    if (!result.ok) {
      setBusy(false)
      failed(result.error)
      return
    }
    // Busy until the browser answers, so a second click can't launch Slack's page again. A failed
    // launch says so, and Approve in Slack comes back to try again.
    if (result.value && 'authorizeUrl' in result.value) {
      await openSlackApprovalHere(result.value.authorizeUrl)
    }
    setBusy(false)
    await refreshBotSlack(bot)
  }

  const pick = async (choice: SlackPostAs): Promise<void> => {
    setOpen(false)
    if (setupState !== undefined) {
      if (choice === current) {
        return
      }
      setApplying(choice)
      const result = await calls.setPostAs({ botId: bot.id, teamId, postAs: choice, setupState })
      if (!result.ok) {
        setApplying(null)
        failed(result.error)
        return
      }
      // The install link is no longer the newest: this pick, too, waits on approval.
      if (result.value && 'authorizeUrl' in result.value) {
        setApplying(null)
        setAsked(choice)
        return
      }
      await refreshBotSlack(bot)
      setApplying(null)
      return
    }
    if (choice === slack.postAs) {
      await cancel()
      return
    }
    setAsked(choice)
  }

  const cancel = async (): Promise<void> => {
    setAsked(null)
    if (slack.postAsPending) {
      const result = await calls.setPostAs({ botId: bot.id, teamId, cancel: true })
      if (!result.ok) {
        failed(result.error)
      }
      await refreshBotSlack(bot)
    }
  }

  return (
    <div className={cn('text-xs leading-5 text-muted-foreground', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <Trans
          i18n={i18n}
          i18nKey="bots.slack.postAs.line"
          defaults="When you reply to a Slack thread from Orca, it posts as <picker>{{name}}</picker>"
          values={{ name: posters[current].name }}
          shouldUnescape
          components={{ picker: <PickerName /> }}
        />
        <PopoverContent align="start" className="w-72">
          <div
            role="radiogroup"
            aria-label={t('bots.slack.postAs.caption', 'In this bot’s Slack threads')}
            className="flex flex-col gap-1"
          >
            {(['person', 'computer'] as const).map((choice) => (
              <SlackPostPreview
                key={choice}
                poster={posters[choice]}
                checked={choice === (waiting ?? current)}
                onPick={() => void pick(choice)}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {waiting ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <p className="w-full">
            {slack.installerName
              ? t(
                  'bots.slack.postAs.waitingOn',
                  'Switching to {{name}} needs {{installer}} to approve in Slack.',
                  { name: posters[waiting].name, installer: slack.installerName }
                )
              : t('bots.slack.postAs.waiting', 'Switching to {{name}} needs approval in Slack.', {
                  name: posters[waiting].name
                })}
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void requestApproval(waiting)}
          >
            {t('bots.slack.postAs.approve', 'Approve in Slack')}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void cancel()}>
            {t('bots.slack.postAs.cancel', 'Cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** The name in the line, as the picker's trigger: plain text, dotted underline, a small chevron. */
function PickerName({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        className="inline-flex items-baseline gap-1 rounded-sm text-foreground underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {children}
        <ChevronDown className="size-3 self-center text-muted-foreground" />
      </button>
    </PopoverTrigger>
  )
}

/** One choice, drawn as the tiny Slack post it makes. */
function SlackPostPreview({
  poster,
  checked,
  onPick
}: {
  poster: Poster
  checked: boolean
  onPick: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const time = SAMPLE_TIME.toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' })
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      className={cn(
        SLACK_POST,
        'relative flex w-full items-start gap-2 rounded-lg border p-2 text-left outline-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        checked ? 'border-foreground/70' : 'border-border hover:border-foreground/30'
      )}
    >
      <span className="size-8 shrink-0 overflow-hidden rounded-md">{poster.avatar}</span>
      <span className="min-w-0 flex-1 pr-5">
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-[13px] leading-[18px] font-black">
            {t('bots.slack.postAs.viaOrca', '{{name}} (via Orca)', { name: poster.name })}
          </span>
          <span className="shrink-0 rounded-sm bg-[var(--slack-muted)]/15 px-0.5 text-[9px] leading-3 font-bold text-[var(--slack-muted)]">
            {t('bots.slack.postAs.app', 'APP')}
          </span>
          <span className="shrink-0 text-[11px] text-[var(--slack-muted)]">{time}</span>
        </span>
        <span className="block text-[13px] leading-[18px]">
          {t('bots.slack.postAs.sample', 'Ship it after that')}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          'absolute top-2 right-2 flex size-3.5 items-center justify-center rounded-full border',
          checked
            ? 'border-foreground bg-foreground text-background'
            : 'border-[var(--slack-muted)]/40'
        )}
      >
        {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
      </span>
    </button>
  )
}
