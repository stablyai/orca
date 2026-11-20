// A received link's review, laid out as the Share dialog's pages: the same part names and flag spots,
// with every file read from the review instead of a candidate.
import { getIntlLocale, translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import {
  BOT_SHARE_MEMORY_INDEX,
  type BotShareReview
} from '../../../../../shared/bots/bot-share-received'
import { BOT_CONNECTORS } from '../bot-connectors'
import { botShareFlagSpot, type BotShareFlagSpot } from './bot-share-flags'
import type { BotSharePage } from './bot-share-pages'

export type BotShareReviewList =
  | 'skills'
  | 'automations'
  | 'tools'
  | 'accounts'
  | 'memory'
  | 'check'
  | 'leftOut'

export type BotShareReviewPage =
  | { kind: 'list'; list: BotShareReviewList }
  | Extract<BotSharePage, { kind: 'part' }>

export type BotShareReviewFile = BotShareReview['files'][number]

/** Where each of the review's flags shows, as the sharer's Share dialog places them. */
export function reviewFlagSpots(review: BotShareReview): BotShareFlagSpot[] {
  const { bot } = review
  const source = {
    bot,
    automationIds: {
      schedules: bot.schedules.map((schedule) => schedule.id),
      eventSuggestions: bot.eventSuggestions.map((event) => event.id)
    },
    available: {
      skills: bot.skills.map(({ name }) => ({ name, description: '', homePath: `skills/${name}` }))
    }
  }
  return review.flags.map((flag) => botShareFlagSpot(flag, source))
}

/** The review page that shows a flag; the Share dialog's setup-note page is Accounts to connect here. */
export function reviewFlagPage(page: BotSharePage | null): BotShareReviewPage | null {
  if (!page) {
    return null
  }
  if (page.kind === 'list') {
    return { kind: 'list', list: 'accounts' }
  }
  // A skill's page is the skill, as its row in Skills opens it.
  return page.part.startsWith('skill:')
    ? { ...page, title: page.part.slice('skill:'.length), showNames: true }
    : page
}

/** A bot.json text as a file: its flagged lines are the review's flags on that field. */
function manifestText(
  review: BotShareReview,
  field: string,
  path: string,
  text: string
): BotShareReviewFile {
  const flags = review.flags.flatMap((flag) =>
    flag.where === `bot.json#${field}` && flag.line !== null && flag.kind !== 'runnable'
      ? [{ kind: flag.kind, line: flag.line }]
      : []
  )
  return { path, text, flags }
}

/** The files a part page shows. */
export function reviewPartFiles(review: BotShareReview, part: string): BotShareReviewFile[] {
  const { bot, files } = review
  const [kind, ...rest] = part.split(':')
  const name = rest.join(':')
  switch (kind) {
    case 'soul':
      return files.filter((file) => file.path === 'SOUL.md')
    case 'skill':
      return files
        .filter((file) => file.path.startsWith(`skills/${name}/`))
        .map((file) => ({ ...file, path: file.path.slice(`skills/${name}/`.length) }))
    case 'memory':
      return files.filter((file) => file.path === `memory/${name}.md`)
    case 'memory-index':
      return files.filter((file) => file.path === BOT_SHARE_MEMORY_INDEX)
    case 'schedule': {
      const index = bot.schedules.findIndex((schedule) => schedule.id === name)
      const schedule = bot.schedules[index]
      return schedule
        ? [manifestText(review, `schedules.${index}.prompt`, schedule.name, schedule.prompt)]
        : []
    }
    case 'event': {
      const index = bot.eventSuggestions.findIndex((event) => event.id === name)
      const event = bot.eventSuggestions[index]
      return event
        ? [manifestText(review, `eventSuggestions.${index}.prompt`, event.name, event.prompt)]
        : []
    }
    case 'note':
      return bot.setupNote ? [manifestText(review, 'setupNote', 'note', bot.setupNote)] : []
    default:
      return []
  }
}

/** "GitHub, Slack": the accounts a bot made from the link asks its owner to connect. */
export function reviewAccounts(review: BotShareReview): string[] {
  return review.bot.connectors.map(
    ({ kind }) =>
      BOT_CONNECTORS.find((connector) => connector.id === kind)?.label ??
      (kind === 'composio' ? 'Composio' : kind)
  )
}

/** "Dara · Nov 8, 2026 · Not reviewed": who shared it and when, from their account. */
export function reviewByline(review: BotShareReview): string {
  const date = uiDateTimeFormat(
    { month: 'short', day: 'numeric', year: 'numeric' },
    getIntlLocale()
  ).format(new Date(review.publishedAt))
  return translate('bots.share.review.byline', '{{who}} · {{date}} · Not reviewed', {
    who: review.publisher ?? translate('bots.share.review.someone', 'Someone'),
    date
  })
}

/** A tool's address as the tick names it: the host, which is what the bot contacts. */
export function toolHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
