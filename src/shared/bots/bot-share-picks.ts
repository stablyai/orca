// What the owner last published a bot with, so Update link starts from those picks and that note.
import * as z from 'zod'
import { BOT_PACKAGE_SETUP_NOTE_MAX } from './bot-package'

const Names = z.array(z.string().min(1).max(200)).max(64).optional()

/** The longest skill folder a saved opt-in keeps; a longer one is not saved, so it starts unticked. */
export const BOT_SHARE_PICK_DIRECTORY_MAX = 4096

/** A skill linked into a project from outside it that the owner ticked, and the folder it was in. */
export const BotShareOutsidePickSchema = z.object({
  name: z.string().min(1).max(200),
  directory: z.string().min(1).max(BOT_SHARE_PICK_DIRECTORY_MAX)
})
export type BotShareOutsidePick = z.infer<typeof BotShareOutsidePickSchema>

/** An absent list is all of that part, except memory, which is off unless named. */
export const BotSharePicksSchema = z.object({
  selection: z.object({
    skills: Names,
    tools: Names,
    schedules: Names,
    eventSuggestions: Names,
    memory: Names
  }),
  setupNote: z.string().max(BOT_PACKAGE_SETUP_NOTE_MAX),
  /** Picked skills linked into a project from outside it, and their folders: the owner's opt-in. */
  outsideSkills: z.array(BotShareOutsidePickSchema).max(64).optional()
})

export type BotSharePicks = z.infer<typeof BotSharePicksSchema>
