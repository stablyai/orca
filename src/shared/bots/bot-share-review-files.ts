// A received link's review, read as the sharer's Share bot pages are: the same flag spots, and each
// part's files taken from the review instead of a candidate.
import { botShareFlagSpot, type BotShareFlagSpot } from './bot-share-flag-spots'
import { BOT_SHARE_MEMORY_INDEX, type BotShareReview } from './bot-share-received'
import type { BotTextFlag } from './bot-text-scan'

type ReviewBot = {
  skills: readonly { name: string }[]
  tools: readonly { name: string }[]
  schedules: readonly { id: string; name: string; prompt: string }[]
  eventSuggestions: readonly { id: string; name: string; prompt: string }[]
  setupNote?: string
}

/** What reading a review's parts needs of it. */
export type BotShareReviewSource = {
  bot: ReviewBot
  files: readonly BotShareReviewFile[]
  flags: BotShareReview['flags']
}

export type BotShareReviewFile = { path: string; text: string; flags: BotTextFlag[] }

/** Where each of the review's flags shows, as the sharer's Share bot places them. */
export function reviewFlagSpots(review: BotShareReviewSource): BotShareFlagSpot[] {
  const { bot } = review
  const source = {
    bot,
    automationIds: {
      schedules: bot.schedules.map((schedule) => schedule.id),
      eventSuggestions: bot.eventSuggestions.map((event) => event.id)
    },
    available: {
      skills: bot.skills.map(({ name }) => ({ name, homePath: `skills/${name}` }))
    }
  }
  return review.flags.map((flag) => botShareFlagSpot(flag, source))
}

/** A bot.json text as a file: its flagged lines are the review's flags on that field. */
function manifestText(
  review: BotShareReviewSource,
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

/** The files a part page shows: `soul`, `skill:<name>`, `memory:<topic>`, `memory-index`,
 *  `schedule:<id>`, `event:<id>` or `note`. */
export function reviewPartFiles(review: BotShareReviewSource, part: string): BotShareReviewFile[] {
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

/** A tool's address as the tick names it: the host, which is what the bot contacts. */
export function toolHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
