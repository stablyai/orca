// What the owner last published a bot with, so Update link starts from those picks and that note.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { BOT_PACKAGE_SETUP_NOTE_MAX } from './bot-package'
import { BotShareOutsidePickSchema } from './bot-share-skill-picks'

const Names = lazyZodSchema(() => z.array(z.string().min(1).max(200)).max(64).optional())

/** An absent list is all of that part, except memory, which is off unless named. */
export const BotSharePicksSchema = lazyZodSchema(() =>
  z.object({
    selection: z.object({
      skills: Names,
      tools: Names,
      schedules: Names,
      eventSuggestions: Names,
      memory: Names,
      outsideSkills: z.array(BotShareOutsidePickSchema).max(64).optional()
    }),
    setupNote: z.string().max(BOT_PACKAGE_SETUP_NOTE_MAX)
  })
)

export type BotSharePicks = z.infer<typeof BotSharePicksSchema>
