// GitHub's Done screen: how to ask the bot, drawn as the two-comment GitHub thread it makes.
import React, { useId } from 'react'
import { CopyTextButton } from '@/components/clipboard/CopyTextButton'
import { ConnectorAvatar } from '@/components/ConnectorAvatar'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { GITHUB_BOT_MENTION } from '../../../../../shared/connector-bot-github-contract'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { gitHubMention } from './bot-github-copy'

// GitHub sets a mention bold in its link blue; the theme's accent is that blue in either scheme.
const MENTION = 'font-semibold text-theme-accent'

export function GitHubTryItPreview({
  bot,
  login,
  userId
}: {
  bot: Bot
  /** The signed-in GitHub user, who asks in the sample. */
  login: string
  /** Their numeric GitHub id, for their picture; initials stand in until (or unless) it loads. */
  userId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const headingId = useId()
  const now = t('bots.github.setup.preview.commented', 'commented now')
  const command = gitHubMention(bot)
  const ask = t('bots.github.setup.preview.ask', 'review this PR')
  const reply = t('bots.github.setup.preview.reply', 'On it.')
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-xs font-medium">
        {t('bots.github.setup.tryIt', 'Try it on any issue or PR')}
      </h3>
      {/* A sample, not a real thread: screen readers get what to do and what it answers instead. */}
      <p className="sr-only">
        {t(
          'bots.github.setup.preview.label',
          'Mention {{command}} on an issue or pull request to ask {{name}}. For example, “{{command}} {{ask}}”, and {{name}} replies “{{reply}}”',
          { command, name: bot.name, ask, reply }
        )}
      </p>
      <div className="space-y-3 rounded-lg border border-border bg-background p-3">
        <GitHubComment
          avatar={
            <ConnectorAvatar
              avatarUrl={userId ? `https://avatars.githubusercontent.com/u/${userId}` : null}
              name={login}
              className="size-full"
            />
          }
          round
          threaded
          name={login}
          time={now}
          action={
            <CopyTextButton
              text={command}
              label={t('bots.setup.copyHowToAsk', 'Copy {{text}}', { text: command })}
            />
          }
        >
          {/* What to type keeps its room: the sample ask ends in "…" first, and only a handle
              wider than the whole row is cut. */}
          <span className="max-w-full shrink-0 truncate">
            <span className={MENTION}>{GITHUB_BOT_MENTION}</span> {bot.folder}
          </span>{' '}
          <span className="min-w-0 truncate">{ask}</span>
        </GitHubComment>
        <GitHubComment
          avatar={<BotAvatar bot={bot} className="size-full rounded-md border-0" />}
          name={bot.name}
          label={t('bots.github.setup.preview.bot', 'bot')}
          time={now}
        >
          <span className="min-w-0 truncate">{reply}</span>
        </GitHubComment>
      </div>
    </section>
  )
}

/** One GitHub comment: picture, then a box with a header strip and a one-line body. */
function GitHubComment({
  avatar,
  round,
  threaded,
  name,
  label,
  time,
  action,
  children
}: {
  avatar: React.ReactNode
  /** People's pictures are round on GitHub; apps' are rounded squares. */
  round?: boolean
  /** GitHub's timeline: a thin line from this picture down to the next comment's. */
  threaded?: boolean
  name: string
  label?: string
  time: string
  /** Kept out of the hidden sample so it stays reachable. */
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex items-start gap-2">
      {threaded ? (
        <span aria-hidden className="absolute top-6 -bottom-3 left-3 w-px bg-border" />
      ) : null}
      <span
        aria-hidden
        className={cn('size-6 shrink-0 overflow-hidden', round ? 'rounded-full' : 'rounded-md')}
      >
        {avatar}
      </span>
      <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-border">
        <div
          aria-hidden
          className="flex min-w-0 items-center gap-1 border-b border-border bg-muted/50 px-2.5 py-1 text-xs"
        >
          <span className="truncate font-semibold">{name}</span>
          {label ? (
            <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] leading-4 text-foreground/70">
              {label}
            </span>
          ) : null}
          <span className="shrink-0 text-muted-foreground">{time}</span>
        </div>
        <div
          className={cn(
            'flex min-w-0 items-center gap-1 py-1.5 pl-2.5',
            action ? 'pr-1' : 'pr-2.5'
          )}
        >
          {/* Each part says where its own "…" goes. */}
          <p
            aria-hidden
            className="flex min-w-0 flex-1 gap-1 text-[13px] leading-5 whitespace-nowrap"
          >
            {children}
          </p>
          {action ? <span className="-my-1 shrink-0">{action}</span> : null}
        </div>
      </div>
    </div>
  )
}
