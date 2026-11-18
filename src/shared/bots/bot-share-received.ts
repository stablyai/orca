// A received shared bot as its review shows it. The files are what Create writes, byte for byte;
// main builds both from one list (bot-share-received-files.ts).
import type { BotPackageV1, BotShareFlag } from './bot-package'
import type { BotTextFlag } from './bot-text-scan'

/** Codes `bots.create({ fromShare })` throws, which the review maps to its own words. */
export const BOT_SHARE_RECEIVE_ERRORS = {
  /** The link serves a newer version than the one reviewed: review it again. */
  updated: 'bot_share_updated',
  /** The link was stopped, or never existed. */
  stopped: 'bot_share_stopped',
  /** The review is gone (it expired, or Orca restarted): open the link again. */
  expired: 'bot_share_review_expired'
} as const

/** The review's file for the lines Create adds to the new home's MEMORY.md. */
export const BOT_SHARE_MEMORY_INDEX = 'MEMORY.md'

/** A shared bot as its review shows it: the version the link serves now. Main keeps the content under
 *  `reviewId`; Create names only that id. */
export type BotShareReview = {
  reviewId: string
  shareId: string
  /** The version reviewed. */
  versionId: string
  /** The sharer's account name; null when the account has none. */
  publisher: string | null
  publishedAt: string
  bot: BotPackageV1
  /** Every file Create writes, by its package path, exactly as written; flags are read from that
   *  text. `MEMORY.md` is the new home's complete index. */
  files: { path: string; text: string; flags: BotTextFlag[] }[]
  /** The safety check of bot.json's strings and the files as written. */
  flags: BotShareFlag[]
  /** What the package had that Create doesn't write: unused bot.json fields, a skill's frontmatter
   *  keys past name and description ("allowed-tools in changelog-style"), files that aren't plain
   *  documents ("scripts/run.sh in changelog-style"). */
  leftOut: string[]
  /** The archive's picture, as a data URL, when the bot has one. */
  avatarDataUrl: string | null
}
