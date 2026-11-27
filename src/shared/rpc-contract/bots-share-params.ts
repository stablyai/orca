// Sharing a bot by link: the candidate the owner reviews, publishing it, moving or stopping the link.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { BotShareOutsidePickSchema } from '../bots/bot-share-skill-picks'
import { requiredString } from './rpc-param-primitives'

/** The most names one part's pick may carry; the picker never sends more. */
export const BOT_SHARE_MAX_PICKS = 64
const Names = lazyZodSchema(() =>
  z.array(z.string().min(1).max(200)).max(BOT_SHARE_MAX_PICKS).optional()
)
const BotId = requiredString('Missing bot')

/** The owner's picks; an absent list shares all of that part, except memory, which is off unless named. */
export const BotSharePrepare = lazyZodSchema(() =>
  z.object({
    botId: BotId,
    skills: Names,
    tools: Names,
    schedules: Names,
    eventSuggestions: Names,
    memory: Names,
    /** The owner's ticks on skills linked into a project from outside it. */
    outsideSkills: z.array(BotShareOutsidePickSchema).max(BOT_SHARE_MAX_PICKS).optional(),
    purpose: z.string().max(200).optional(),
    /** Built in, so the candidate digests as a version published with this note would. */
    setupNote: z.string().max(2000).optional(),
    /** Build from the picks and note the bot was last published with, and return them. */
    last: z.boolean().optional(),
    /** Build a review without waiting for the cloud package lookup. */
    localOnly: z.boolean().optional(),
    /** The open dialog this build is for: its skill listing is kept for its picks, and its newer
     *  fresh build replaces its older one. A host that predates this ignores it. */
    skillsSession: z.string().min(1).max(100).optional(),
    /** Only the picks changed in `skillsSession`: list the skills it last listed, unwalked. A host
     *  that predates this ignores it and reads them again. */
    reuseSkills: z.boolean().optional()
  })
)

export const BotShareCandidate = lazyZodSchema(() =>
  z.object({
    botId: BotId,
    candidateId: requiredString('Missing candidate')
  })
)

/** Publish the candidate with the setup note on screen; with `link` it is *Update link*: the link the owner sees, from the version it
 *  showed them, never a new link. */
export const BotSharePublish = lazyZodSchema(() =>
  BotShareCandidate.extend({
    setupNote: z.string().max(2000).optional(),
    link: z
      .object({
        shareId: requiredString('Missing link'),
        expectedVersionId: requiredString('Missing version')
      })
      .optional()
  })
)

/** A link the signed-in account owns; Orca Cloud refuses any other. It needs no bot on this computer:
 *  a deleted bot's link, or one made on another install, can be stopped too. */
export const BotShareStop = lazyZodSchema(() =>
  z.object({
    shareId: requiredString('Missing link'),
    /** The bot the link shares, when known: its stored picks on this computer go too. */
    botId: z.string().min(1).optional()
  })
)

/** The owner's live bot links. */
export const BotShareStatusParams = lazyZodSchema(() =>
  z.object({
    /** A bot whose link should also carry its version's publish time and digest. */
    botId: z.string().min(1).optional()
  })
)

/** One part's exact text: `soul`, `skill:<name>`, `memory:<topic>`, `schedule:<id>`, `event:<id>`,
 *  `tool:<name>`. */
export const BotSharePartView = lazyZodSchema(() =>
  BotShareCandidate.extend({
    part: z.string().min(1).max(300)
  })
)

const ShareId = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Not a bot link'))
const VersionId = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))

/** A shared link to review before making a bot from it; with `versionId`, a copy's original, which
 *  is gone once the link has moved past it. */
export const BotShareReviewParams = lazyZodSchema(() =>
  z.object({ shareId: ShareId, versionId: VersionId.optional() })
)
