// A shared bot, as its link carries it: the bot.json schema, the parts its archive may hold, and the
// pure mapping from a parsed package to the bot it creates. No filesystem work here.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import type { AutomationBotResultsTo } from '../automation-bot-target'
import { AUTOMATION_EVENT_KINDS } from '../automation-event-triggers'
import { GOOGLE_EVENT_SOURCES } from '../automation-google-triggers'
import { BOT_MASCOT_IDS, BOT_AVATAR_FILE, mascotAvatar } from '../bot-avatar'
import { BotAvatarColorSchema } from './bot-avatar-color'
import { BotStoredOutfitSchema } from './bot-avatar-outfit'
import { BOT_TOOL_HEADER_NAME_PATTERN, BOT_TOOL_NAME_PATTERN, BotToolUrl } from '../bot-tools'
import { BotAgentReadSchema, BotNameSchema, type BotAgent } from '../bot-types'
import { validateSkillPackageName } from '../skills/packages/skill-package-manifest'
import type { BotTextFlagKind } from './bot-text-scan'

export const BOT_PACKAGE_SCHEMA_VERSION = 1
export const BOT_PACKAGE_MANIFEST_PATH = 'dev.orca.bot-sharing/bot.json'
export const BOT_PACKAGE_SOUL_PATH = 'SOUL.md'
export const BOT_PACKAGE_AVATAR_PATH = BOT_AVATAR_FILE
export const BOT_PACKAGE_MAX_MANIFEST_BYTES = 256 * 1024
export const BOT_PACKAGE_PURPOSE_MAX = 200
/** The most skills one package carries. */
export const BOT_PACKAGE_SKILLS_MAX = 64
export const BOT_PACKAGE_SETUP_NOTE_MAX = 2000

/** Skill and memory names: they become folder and file names, so the skill name rules apply. */
const PartName = lazyZodSchema(() =>
  z.string().refine((name) => {
    try {
      validateSkillPackageName(name)
      return true
    } catch {
      return false
    }
  }, 'Use lowercase letters, digits and dashes')
)
const PartId = lazyZodSchema(() => z.string().regex(/^[a-z0-9-]{1,32}$/))
const Prompt = lazyZodSchema(() => z.string().min(1).max(20_000))

/** Where a copy's results go, by kind only: the channel or issue is the recipient's to pick. */
export const BOT_PACKAGE_RESULTS = ['chat', 'slack-channel', 'linear-issue', 'none'] as const
export const BOT_PACKAGE_EVENT_RESULTS = [...BOT_PACKAGE_RESULTS, 'thread'] as const
export const BOT_PACKAGE_CONNECTORS = ['github', 'slack', 'linear', 'google', 'composio'] as const
const EVENT_SOURCES = ['slack', 'github', 'linear', ...GOOGLE_EVENT_SOURCES] as const

const EventSuggestionSchema = lazyZodSchema(() =>
  z
    .object({
      id: PartId,
      name: z.string().min(1).max(200),
      prompt: Prompt,
      source: z.enum(EVENT_SOURCES),
      event: z.string().min(1).max(64),
      textContains: z.string().min(1).max(200).optional(),
      results: z.enum(BOT_PACKAGE_EVENT_RESULTS)
    })
    .refine((suggestion) => {
      const kinds: readonly string[] = AUTOMATION_EVENT_KINDS[suggestion.source]
      return kinds.includes(suggestion.event)
    })
)

export const BotPackageV1Schema = lazyZodSchema(() =>
  z.object({
    schemaVersion: z.literal(BOT_PACKAGE_SCHEMA_VERSION),
    name: BotNameSchema,
    /** A mascot by id, with its tile color and outfit, or the archive's avatar.png; absent, the recipient's
     *  default mascot. An older importer drops the color and outfit and lists them as not included. */
    avatar: z
      .union([
        z.object({
          mascot: z.enum(BOT_MASCOT_IDS),
          color: BotAvatarColorSchema.optional().catch(undefined),
          outfit: BotStoredOutfitSchema.optional().catch(undefined)
        }),
        z.object({ image: z.literal(BOT_PACKAGE_AVATAR_PATH) })
      ])
      .optional(),
    purpose: z.string().max(BOT_PACKAGE_PURPOSE_MAX),
    /** The sharer's agent; the recipient picks their own. */
    agentHint: BotAgentReadSchema,
    skills: z.array(z.object({ name: PartName })).max(BOT_PACKAGE_SKILLS_MAX),
    tools: z
      .array(
        z.object({
          id: PartId,
          name: z.string().regex(BOT_TOOL_NAME_PATTERN),
          url: BotToolUrl,
          headerNames: z.array(z.string().regex(BOT_TOOL_HEADER_NAME_PATTERN)).max(16)
        })
      )
      .max(32),
    connectors: z.array(z.object({ kind: z.enum(BOT_PACKAGE_CONNECTORS) })).max(8),
    schedules: z
      .array(
        z.object({
          id: PartId,
          name: z.string().min(1).max(200),
          prompt: Prompt,
          rrule: z.string().min(1).max(512),
          timezone: z.string().min(1).max(64).optional(),
          results: z.enum(BOT_PACKAGE_RESULTS)
        })
      )
      .max(32),
    eventSuggestions: z.array(EventSuggestionSchema).max(32),
    memory: z.array(z.object({ topic: PartName })).max(64),
    /** Shown to the recipient verbatim, as untrusted text. */
    setupNote: z.string().max(BOT_PACKAGE_SETUP_NOTE_MAX).optional()
  })
)

export type BotPackageV1 = z.infer<typeof BotPackageV1Schema>
export type BotPackageConnector = (typeof BOT_PACKAGE_CONNECTORS)[number]

export const BOT_PACKAGE_NEWER_ERROR = 'bot-package-newer-schema'

/** Keys of `input` the parse dropped, as dotted paths (`tools.0.env`). */
function droppedKeys(input: unknown, parsed: unknown, path: string[] = []): string[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((entry, index) =>
      droppedKeys(entry, parsed[index], [...path, String(index)])
    )
  }
  if (!input || typeof input !== 'object' || !parsed || typeof parsed !== 'object') {
    return []
  }
  const kept = new Map(Object.entries(parsed))
  return Object.entries(input).flatMap(([key, value]) =>
    kept.has(key) ? droppedKeys(value, kept.get(key), [...path, key]) : [[...path, key].join('.')]
  )
}

/** A strict parse that strips unknown keys and lists them; a newer schema is refused. */
export function parseBotPackage(value: unknown): { bot: BotPackageV1; droppedKeys: string[] } {
  const schemaVersion =
    value && typeof value === 'object' && 'schemaVersion' in value ? value.schemaVersion : null
  if (typeof schemaVersion === 'number' && schemaVersion > BOT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(BOT_PACKAGE_NEWER_ERROR)
  }
  const parsed = BotPackageV1Schema.safeParse(value)
  if (!parsed.success) {
    throw new Error('bot-package-invalid')
  }
  const ids = [
    ...parsed.data.tools.map((tool) => `tool:${tool.id}`),
    ...parsed.data.schedules.map((schedule) => `schedule:${schedule.id}`),
    ...parsed.data.eventSuggestions.map((suggestion) => `event:${suggestion.id}`)
  ]
  const names = [
    ...parsed.data.skills.map((skill) => `skill:${skill.name}`),
    ...parsed.data.memory.map((note) => `memory:${note.topic}`)
  ]
  if (new Set([...ids, ...names]).size !== ids.length + names.length) {
    throw new Error('bot-package-duplicate-part')
  }
  return { bot: parsed.data, droppedKeys: droppedKeys(value, parsed.data) }
}

/** What one archive path is; null for any path a bot archive may not hold. */
export type BotPackagePart =
  | { role: 'manifest' }
  | { role: 'soul' }
  | { role: 'avatar' }
  | { role: 'memory'; topic: string }
  | { role: 'skill'; name: string; path: string }

const MEMORY_PATH = /^memory\/([^/]+)\.md$/
const SKILL_PATH = /^skills\/([^/]+)\/(.+)$/

export function botPackagePartOf(path: string): BotPackagePart | null {
  if (path === BOT_PACKAGE_MANIFEST_PATH) {
    return { role: 'manifest' }
  }
  if (path === BOT_PACKAGE_SOUL_PATH) {
    return { role: 'soul' }
  }
  if (path === BOT_PACKAGE_AVATAR_PATH) {
    return { role: 'avatar' }
  }
  const memory = MEMORY_PATH.exec(path)
  if (memory && PartName.safeParse(memory[1]).success) {
    return { role: 'memory', topic: memory[1] }
  }
  const skill = SKILL_PATH.exec(path)
  if (skill && PartName.safeParse(skill[1]).success) {
    return { role: 'skill', name: skill[1], path: skill[2] }
  }
  return null
}

/** The role string the transport inventory records for a part. */
export function botPackageRole(part: BotPackagePart): string {
  return part.role === 'skill' ? `skill:${part.name}` : part.role
}

/** A results place, by kind. */
export function botPackageResults(
  resultsTo: AutomationBotResultsTo
): (typeof BOT_PACKAGE_EVENT_RESULTS)[number] {
  if (typeof resultsTo === 'string') {
    return resultsTo
  }
  return 'channel' in resultsTo ? 'slack-channel' : 'linear-issue'
}

/** A bot's own skills, in its home, for every agent: Orca links each into the agents' skills folders. */
export const BOT_OWN_SKILLS_FOLDER = 'skills'

/** Where each agent loads skills from in a bot's home: Claude, then the folder every other agent reads. */
export const BOT_AGENT_SKILLS_FOLDERS = {
  claude: '.claude/skills',
  agents: '.agents/skills'
} as const
export type BotAgentSkillsFolder = keyof typeof BOT_AGENT_SKILLS_FOLDERS

export type BotPackagePlan = {
  create: { name: string; agent: BotAgent; avatar?: string }
  /** The archive's avatar.png, set as the upload; null keeps `create.avatar` or the default mascot. */
  avatarImage: string | null
  /** Every archive file but bot.json and the avatar, and the home path it is written to. */
  files: { from: string; to: string; executable: boolean }[]
  tools: BotPackageV1['tools']
  /** Never enabled: the recipient turns each on. */
  schedules: (BotPackageV1['schedules'][number] & { enabled: false })[]
  eventSuggestions: BotPackageV1['eventSuggestions']
  connectors: BotPackageConnector[]
  setupNote: string | null
}

/** What a shared mascot carries of the sharer's look: its tile color and outfit. */
export function packagedMascotLook(bot: {
  avatarColor?: string | null
  avatarOutfit?: string | null
}): { color?: string; outfit?: string } {
  return {
    ...(bot.avatarColor ? { color: bot.avatarColor } : {}),
    ...(bot.avatarOutfit ? { outfit: bot.avatarOutfit } : {})
  }
}

/** The bot a package creates, and where each of its files goes. `inventory` is the archive's files;
 *  tools are only the ones the recipient ticked. */
export function planBotFromPackage(
  bot: BotPackageV1,
  inventory: readonly { path: string; executable: boolean }[],
  choice: { agent: BotAgent; toolIds: readonly string[] }
): BotPackagePlan {
  const ticked = new Set(choice.toolIds)
  const files = inventory.flatMap((file) => {
    const part = botPackagePartOf(file.path)
    if (!part) {
      throw new Error('bot-package-path-not-allowed')
    }
    const to =
      part.role === 'soul'
        ? BOT_PACKAGE_SOUL_PATH
        : part.role === 'memory'
          ? `memory/${part.topic}.md`
          : part.role === 'skill'
            ? `${BOT_OWN_SKILLS_FOLDER}/${part.name}/${part.path}`
            : null
    return to === null ? [] : [{ from: file.path, to, executable: file.executable }]
  })
  return {
    create: {
      name: bot.name,
      agent: choice.agent,
      ...(bot.avatar && 'mascot' in bot.avatar ? { avatar: mascotAvatar(bot.avatar.mascot) } : {})
    },
    avatarImage: bot.avatar && 'image' in bot.avatar ? bot.avatar.image : null,
    files,
    tools: bot.tools.filter((tool) => ticked.has(tool.id)),
    schedules: bot.schedules.map((schedule) => ({ ...schedule, enabled: false as const })),
    eventSuggestions: bot.eventSuggestions,
    connectors: bot.connectors.map((connector) => connector.kind),
    setupNote: bot.setupNote ?? null
  }
}

// ---- The candidate a Share dialog shows ----

/** A part that never goes out, and why: a command tool, a webhook, an imported note. */
export type BotShareLeftOut = {
  kind: 'skill' | 'tool' | 'automation' | 'memory' | 'avatar'
  name: string
  why: string
  /** Where in the home it is, when another part shares its name (a skill in two folders). */
  from?: string
}

export type BotShareFlag = {
  /** An archive path, or `bot.json#<field>` for a manifest string. */
  where: string
  line: number | null
  kind: BotTextFlagKind | 'runnable'
}

/** Everything the bot could share, ticked or not, for the Share dialog's pages. */
export type BotShareAvailable = {
  soulLines: number
  /** homePath: null for a linked project's skill, outside the bot home. optInFrom: the project's name
   *  for a skill it links in from outside itself, listed unticked; optInKey: its folder's key. */
  skills: {
    name: string
    description: string
    homePath: string | null
    optInFrom?: string
    optInKey?: string
  }[]
  schedules: { automationId: string; name: string; rrule: string; timezone?: string }[]
  eventSuggestions: { automationId: string; name: string; source: string; event: string }[]
  tools: { name: string; url: string }[]
  memory: { topic: string; lines: number }[]
}

export type BotShareCandidateSummary = {
  candidateId: string
  packageId: string
  versionId: string
  botDigest: string
  archiveSha256: string
  compressedBytes: number
  fileCount: number
  totalBytes: number
  bot: BotPackageV1
  files: { path: string; role: string; size: number; executable: boolean }[]
  leftOut: BotShareLeftOut[]
  /** What the picked parts had that the link doesn't carry: a skill's other frontmatter keys, files that
   *  aren't plain documents ("allowed-tools in changelog-style", "scripts/run.sh in changelog-style"). */
  notIncluded: string[]
  /** Picked files whose shared text differs from the home's (a rebuilt SKILL.md): their line numbers
   *  are the shared text's, not the home file's. */
  rewritten: string[]
  available: BotShareAvailable
  /** The source automation of each shared schedule and event suggestion, by its index in `bot`. */
  automationIds: { schedules: string[]; eventSuggestions: string[] }
  flags: BotShareFlag[]
  /** A secret was found: publishing is refused until the owner removes it. */
  blocked: boolean
  expiresAt: string
}

/** One file of a part as the Share dialog shows it: its exact text (null for a binary file), where it
 *  lives in the bot home (null for text kept in bot.json), and its flagged lines. */
export type BotSharePartFile = {
  path: string
  homePath: string | null
  text: string | null
  flags: { line: number; kind: BotTextFlagKind }[]
}
