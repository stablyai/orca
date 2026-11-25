// Slack's Done screen: how to ask the bot, drawn as the two-message Slack DM it makes.
import React, { useId } from 'react'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { SlackPersonPlaceholder } from './SlackPersonPlaceholder'

// Slack's mention highlight: its own blue, so the @name reads as a Slack mention in either theme.
// The mention is what to type, so it keeps its room; only a name wider than the row ends in "…".
const MENTION =
  'inline-block max-w-full truncate rounded-[3px] align-top bg-[#1d9bd1]/10 px-0.5 text-[#1264a3] dark:bg-[#1d9bd1]/25 dark:text-[#1d9bd1]'

export function SlackTryItPreview({
  bot,
  asker
}: {
  bot: Bot
  /** Whoever asks in the sample: the person who installed it, else "You". */
  asker: string | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const headingId = useId()
  const now = t('bots.slack.setup.preview.now', 'now')
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-xs font-medium">
        {t('bots.slack.setup.tryIt', 'Try it in any channel or DM')}
      </h3>
      {/* A sample, not a real conversation: screen readers get what to do instead. */}
      <p className="sr-only">
        {t('bots.slack.setup.preview.label', 'Mention @{{name}} in Slack to ask it.', {
          name: bot.name
        })}
      </p>
      <div aria-hidden className="space-y-3 rounded-lg border border-border bg-background p-3">
        <SlackMessage
          avatar={<SlackPersonPlaceholder />}
          name={asker ?? t('bots.slack.setup.preview.you', 'You')}
          time={now}
        >
          {/* The name stays out of the message: Trans would read tags in a name like "Ops <i>EU</i>". */}
          <Trans
            i18n={i18n}
            i18nKey="bots.slack.setup.preview.ask"
            defaults="<mention/> summarize this thread"
            components={{ mention: <SlackMention name={bot.name} /> }}
          />
        </SlackMessage>
        <SlackMessage
          avatar={<BotAvatar bot={bot} className="size-full rounded-none border-0" />}
          name={bot.name}
          app
          time={now}
        >
          {t('bots.slack.setup.preview.reply', 'On it.')}
        </SlackMessage>
      </div>
    </section>
  )
}

/** The @name, from a prop: Trans replaces an element's own children. */
function SlackMention({ name }: { name: string }): React.JSX.Element {
  return (
    <span className={MENTION} title={`@${name}`}>
      @{name}
    </span>
  )
}

/** One Slack message, one line each for who and what: a long name or mention ends in an ellipsis. */
function SlackMessage({
  avatar,
  name,
  app,
  time,
  children
}: {
  avatar: React.ReactNode
  name: string
  app?: boolean
  time: string
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden className="size-8 shrink-0 overflow-hidden rounded-md">
        {avatar}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-[13px] leading-[18px] font-bold">{name}</span>
          {app ? (
            <span className="shrink-0 rounded-sm bg-muted-foreground/15 px-0.5 text-[9px] leading-3 font-bold text-muted-foreground">
              {t('bots.slack.postAs.app', 'APP')}
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] text-muted-foreground">{time}</span>
        </div>
        {/* The text after the mention is the part that ends in "…". */}
        <p className="truncate text-[13px] leading-[18px]">{children}</p>
      </div>
    </div>
  )
}
