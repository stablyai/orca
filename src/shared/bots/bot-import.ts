import { lazyZodSchema } from '../schema/lazy-zod-schema'
// Bringing a bot over from another app: the new bot reads the old one's files itself in its first turn
// (no per-app parser), guided by the orca-cli `bot-import` reference.
import * as z from 'zod'
import { BOT_CREATED_KICKOFF } from '../bot-created-kickoff'
import { type BotSharedFrom, botShareKickoff } from './bot-shared-from'
import { botTemplate, botTemplateKickoff } from './bot-templates'
import { getRuntimePathBasename } from '../file-access/cross-platform-path'

export const BOT_IMPORT_APPS = ['openclaw', 'hermes', 'openbot', 'export'] as const
export type BotImportApp = (typeof BOT_IMPORT_APPS)[number]

export const BOT_IMPORT_APP_LABELS: Record<BotImportApp, string> = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  openbot: 'OpenBot',
  export: 'another app'
}

const path = lazyZodSchema(() => z.string().trim().min(1).max(1024))

/** Where the old bot is: an app's folder on this computer, or what the old bot exported for the owner. */
export const BotImportFromSchema = lazyZodSchema(() =>
  z.object({
    app: z.enum(BOT_IMPORT_APPS),
    /** The old bot's own folder (an OpenClaw workspace, a Hermes profile), or the export folder. */
    path,
    /** The old bot's id in its app (an OpenClaw agent id, a Hermes profile name); absent for an export. */
    agent: z.string().trim().min(1).max(200).optional(),
    /** Files the owner dropped in besides the folder. */
    files: z.array(path).max(50).optional()
  })
)
export type BotImportFrom = z.infer<typeof BotImportFromSchema>

/** What a bot keeps of where it came from: enough to send its first turn again, and to find it on a re-import. */
export const BotImportedFromSchema = lazyZodSchema(() =>
  BotImportFromSchema.extend({
    /** The old bot's name. */
    name: z.string().trim().min(1).max(200).optional(),
    /** Whether the old bot's reply was saved in the new bot's home. */
    reply: z.boolean().optional()
  })
)
export type BotImportedFrom = z.infer<typeof BotImportedFromSchema>

/** What the old bot wrote back when asked for its setup; saved in the new bot's home, never sent as a turn. */
export const BOT_IMPORT_REPLY_MAX = 200_000
export const BOT_IMPORT_REPLY_FILE = 'import/old-bot-reply.md'

/** The message the owner pastes into an old bot whose files Orca can't see. */
export const BOT_IMPORT_EXPORT_PROMPT =
  "I'm moving to another assistant and need a complete copy of your setup. Don't change, pause or delete anything. If you keep your setup in files (persona or soul, memory, user notes, skills, routines), save copies of those files, unchanged, into a folder in my Downloads called <your name>-export, then list what you saved. Write out in full in your reply anything that isn't in a file. Never include passwords, API keys, tokens or cookies."

/** "research-desk" → "Research desk". */
export function botNameFromId(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim()
  return words ? (words[0]?.toUpperCase() ?? '') + words.slice(1) : id
}

/** A name for the new bot from the folder the old bot made: "sage-export" (what the prompt asks for) is "Sage". */
export function botNameFromExportFolder(path: string): string | null {
  const id = getRuntimePathBasename(path).replace(/[-_ ]export$/i, '')
  return id.replace(/[-_ ]+/g, '') ? botNameFromId(id) : null
}

/** Orca's first turn to a bot made from another app's bot: setup becomes the import. */
export function botImportKickoff(from: BotImportedFrom, botName: string): string {
  const app = BOT_IMPORT_APP_LABELS[from.app]
  const where =
    from.app === 'export'
      ? [
          `Its files are in ${from.path}`,
          ...(from.files?.length ? [`, plus ${from.files.join(', ')}`] : []),
          from.reply ? `. What it wrote back is in ${BOT_IMPORT_REPLY_FILE} in your home.` : '.'
        ].join('')
      : `It is ${from.agent ? `"${from.agent}" ` : ''}in ${from.path}.`
  return [
    `${BOT_CREATED_KICKOFF} Your owner made you to take over "${from.name ?? botName}" from ${app}. ${where}`,
    'Bring it over instead of the usual setup: run `orca skills get orca-cli --reference bot-import` first.'
  ].join('\n\n')
}

/** Orca's first turn to a new bot, sent again by Try again: an import's for a bot made from another
 *  app's, a link's for one made from a shared link, a template's for one made from a template. */
export function botFirstKickoff(bot: {
  name: string
  importedFrom?: BotImportedFrom
  sharedFrom?: Pick<BotSharedFrom, 'sharedBy'>
  templateId?: string
}): string {
  if (bot.importedFrom) {
    return botImportKickoff(bot.importedFrom, bot.name)
  }
  if (bot.sharedFrom) {
    return botShareKickoff(bot.sharedFrom)
  }
  const template = botTemplate(bot.templateId)
  return template ? botTemplateKickoff(template) : BOT_CREATED_KICKOFF
}

/** A bot found in another app on this computer. */
export type BotImportCandidate = {
  /** The old bot's id in its app. */
  agent: string
  name: string
  /** Its folder, with the home folder as `~`. */
  path: string
  /** The folder as the host reads it. */
  absolutePath: string
  /** The Orca bot an earlier import made from it, while that bot still exists. */
  importedAs?: { botId: string; name: string }
}

/** An app found on this computer, with the bots in it. */
export type BotImportSource = {
  app: Exclude<BotImportApp, 'export'>
  /** The app's folder, with the home folder as `~`. */
  home: string
  bots: BotImportCandidate[]
}

/** The first-bot nudge's line: OpenClaw's bots, else Hermes'; the apps with the most users first. */
export function botImportNudge(
  sources: readonly BotImportSource[]
): { app: 'openclaw' | 'hermes'; label: string; count: number } | null {
  for (const app of ['openclaw', 'hermes'] as const) {
    const count = sources.find((source) => source.app === app)?.bots.length ?? 0
    if (count > 0) {
      return { app, label: BOT_IMPORT_APP_LABELS[app], count }
    }
  }
  return null
}
