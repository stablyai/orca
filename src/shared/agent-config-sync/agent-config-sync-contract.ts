import { z } from 'zod'

/**
 * Skills and slash commands this computer copies into an Orca Cloud workspace's agent configs.
 * The desktop reads them; the host (orcad in the sandbox) writes them and owns only what it wrote.
 */

/** Where an item lives, on this computer and in the sandbox (the same place on both). */
export const AgentConfigItemKind = z.enum([
  /** ~/.claude/skills/<name>/ or <repo>/.claude/skills/<name>/ */
  'claude-skill',
  /** ~/.claude/commands/<name>.md or <repo>/.claude/commands/<name>.md; `a/b` is the /a:b command. */
  'claude-command',
  /** ~/.agents/skills/<name>/ or <repo>/.agents/skills/<name>/: the skills folder Codex reads. */
  'agents-skill',
  /** ~/.codex/skills/<name>/: Codex's older skills folder. */
  'codex-skill',
  /** ~/.codex/prompts/<name>.md: Codex custom prompts (its slash commands). */
  'codex-prompt',
  /** ~/.claude/agents/<name>.md or <repo>/.claude/agents/<name>.md: Claude subagents. */
  'claude-agent',
  /** ~/.claude/output-styles/<name>.md: Claude output styles. */
  'claude-output-style',
  /** ~/.claude/CLAUDE.md: Claude's user memory (name `CLAUDE`). Off until the user turns it on. */
  'claude-memory',
  /** ~/.codex/AGENTS.md: Codex's global instructions (name `AGENTS`). Off until turned on. */
  'codex-memory'
])
export type AgentConfigItemKind = z.infer<typeof AgentConfigItemKind>

export const AgentConfigItemScope = z.enum(['user', 'project'])
export type AgentConfigItemScope = z.infer<typeof AgentConfigItemScope>

export const AGENT_CONFIG_FILE_KINDS: ReadonlySet<AgentConfigItemKind> = new Set([
  'claude-command',
  'codex-prompt',
  'claude-agent',
  'claude-output-style',
  'claude-memory',
  'codex-memory'
])
/** What the first sync protocol knew. A host that answers `invalid_argument` to the `kinds` field
 * only gets these; the newer kinds wait for a workspace on a newer image. */
export const AGENT_CONFIG_LEGACY_KINDS: ReadonlySet<AgentConfigItemKind> = new Set([
  'claude-skill',
  'claude-command',
  'agents-skill',
  'codex-skill',
  'codex-prompt'
])
/** Personal instructions: they reach a sandbox (which teammates may share) only when turned on. */
export const AGENT_CONFIG_OPT_IN_KINDS: ReadonlySet<AgentConfigItemKind> = new Set([
  'claude-memory',
  'codex-memory'
])
/** The one name a memory item has: its file is `<name>.md` in the agent's config folder. */
export const AGENT_CONFIG_MEMORY_NAME: Partial<Record<AgentConfigItemKind, string>> = {
  'claude-memory': 'CLAUDE',
  'codex-memory': 'AGENTS'
}
/** Kinds Claude Code or Codex reads from a project checkout. */
export const AGENT_CONFIG_PROJECT_KINDS: ReadonlySet<AgentConfigItemKind> = new Set([
  'claude-skill',
  'claude-command',
  'agents-skill',
  'claude-agent'
])

export type AgentConfigAgent = 'claude' | 'codex'
const CODEX_KINDS: ReadonlySet<AgentConfigItemKind> = new Set([
  'agents-skill',
  'codex-skill',
  'codex-prompt',
  'codex-memory'
])
export const agentOfKind = (kind: AgentConfigItemKind): AgentConfigAgent =>
  CODEX_KINDS.has(kind) ? 'codex' : 'claude'
export const isSkillKind = (kind: AgentConfigItemKind): boolean =>
  !AGENT_CONFIG_FILE_KINDS.has(kind)

const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._-]{0,63}'
/** A skill folder name. */
export const AGENT_CONFIG_SKILL_NAME = new RegExp(`^${SEGMENT}$`)
/** A command name, up to two namespace folders deep (`frontend/review` is /frontend:review). */
export const AGENT_CONFIG_COMMAND_NAME = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`)
const FILE_SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._ +@-]{0,127}'
/** A file inside a skill folder: relative, no dot-segments, no hidden files. */
export const AGENT_CONFIG_FILE_PATH = new RegExp(`^${FILE_SEGMENT}(/${FILE_SEGMENT}){0,7}$`)
/** The one file of a command or prompt item. */
export const AGENT_CONFIG_SELF_PATH = '.'

export const AGENT_CONFIG_LIMITS = {
  /** One file in a skill, or one command. */
  fileBytes: 256 * 1024,
  /** One skill folder; also bounds one put call (base64 stays well under the 1 MiB RPC frame). */
  itemBytes: 512 * 1024,
  filesPerItem: 200,
  /** Everything one sync sends to a sandbox. */
  totalBytes: 8 * 1024 * 1024,
  items: 256,
  /** Items per put call (each call also stays under itemBytes). */
  putItems: 32
} as const

export const agentConfigItemKey = (
  scope: AgentConfigItemScope,
  kind: AgentConfigItemKind,
  name: string
): string => `${scope}:${kind}:${name}`

const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Syncer = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const ItemRef = z
  .object({
    scope: AgentConfigItemScope,
    kind: AgentConfigItemKind,
    name: z.string().max(200),
    digest: Digest
  })
  .strict()
  .refine((item) => item.scope === 'user' || AGENT_CONFIG_PROJECT_KINDS.has(item.kind), {
    message: 'This kind has no project scope.'
  })
  .refine(
    (item) =>
      (isSkillKind(item.kind) ? AGENT_CONFIG_SKILL_NAME : AGENT_CONFIG_COMMAND_NAME).test(
        item.name
      ),
    { message: 'Invalid name.' }
  )
export type AgentConfigItemRef = z.infer<typeof ItemRef>

/** The complete set this computer manages; anything it wrote before and no longer sends is removed. */
export const AgentConfigSyncPlanParams = z
  .object({
    syncer: Syncer,
    items: z.array(ItemRef).max(AGENT_CONFIG_LIMITS.items),
    /** Kinds this call manages: only these are pruned. Absent means the legacy five. */
    kinds: z.array(AgentConfigItemKind).max(32).optional()
  })
  .strict()
  .refine(
    (params) =>
      !params.kinds || params.items.every((item) => params.kinds?.includes(item.kind) === true),
    { message: 'An item’s kind is not in kinds.' }
  )
export type AgentConfigSyncPlanParams = z.infer<typeof AgentConfigSyncPlanParams>

export const AgentConfigPlanOutcome = z.enum([
  /** Not there, or this computer's older copy: send it. */
  'needed',
  'unchanged',
  /** The host has its own (or an edited) item of that name; it wins and is never touched. */
  'kept-host',
  /** Project item, but this host has no workspace checkout. */
  'no-project'
])
export type AgentConfigPlanOutcome = z.infer<typeof AgentConfigPlanOutcome>

export const AgentConfigSyncPlanResult = z.object({
  items: z.record(z.string(), AgentConfigPlanOutcome),
  removed: z.number().int().nonnegative()
})
export type AgentConfigSyncPlanResult = z.infer<typeof AgentConfigSyncPlanResult>

const FilePayload = z
  .object({
    path: z
      .string()
      .max(600)
      .refine((path) => path === AGENT_CONFIG_SELF_PATH || AGENT_CONFIG_FILE_PATH.test(path)),
    executable: z.boolean(),
    base64: z.string().max(Math.ceil(AGENT_CONFIG_LIMITS.fileBytes / 3) * 4 + 4)
  })
  .strict()
export type AgentConfigFilePayload = z.infer<typeof FilePayload>

export const AgentConfigSyncPutParams = z
  .object({
    syncer: Syncer,
    items: z
      .array(
        z
          .object({
            scope: AgentConfigItemScope,
            kind: AgentConfigItemKind,
            name: z.string().max(200),
            digest: Digest,
            files: z.array(FilePayload).min(1).max(AGENT_CONFIG_LIMITS.filesPerItem)
          })
          .strict()
      )
      .min(1)
      .max(AGENT_CONFIG_LIMITS.putItems)
  })
  .strict()
export type AgentConfigSyncPutParams = z.infer<typeof AgentConfigSyncPutParams>
export type AgentConfigItemPayload = AgentConfigSyncPutParams['items'][number]

export const AgentConfigPutOutcome = z.enum([
  'added',
  'updated',
  'kept-host',
  'no-project',
  /** Payload did not match its digest or broke a limit. */
  'invalid',
  'failed'
])
export type AgentConfigPutOutcome = z.infer<typeof AgentConfigPutOutcome>

export const AgentConfigSyncPutResult = z.object({
  items: z.record(z.string(), AgentConfigPutOutcome)
})
export type AgentConfigSyncPutResult = z.infer<typeof AgentConfigSyncPutResult>

export const AGENT_CONFIG_SYNC_PLAN_METHOD = 'agentConfig.planSkillSync'
export const AGENT_CONFIG_SYNC_PUT_METHOD = 'agentConfig.putSkills'

/** Why this computer does not send an item; each row shows one. */
export type AgentConfigSkipReason =
  | 'turned-off'
  /** Project item that git tracks: the sandbox's clone already has it. */
  | 'in-repo'
  | 'too-large'
  | 'over-limit'
  /** The skill's main file (or the command) looks like it holds a key or token. */
  | 'secret'
  | 'invalid'
  /** This sandbox's Orca predates this kind (subagents, output styles, memory). */
  | 'host-outdated'

/** One item as the UI sees it: never file contents. */
export type AgentConfigSyncRow = {
  key: string
  scope: AgentConfigItemScope
  kind: AgentConfigItemKind
  name: string
  bytes: number
  fileCount: number
  /** Files kept on this computer because they look like keys or credentials. */
  withheldFiles: number
  /** Memory that imports files from outside its folder (`@/path`): those aren't copied. */
  localRefs?: number
  /** Set on a copy made for the other agent: the key of the item it came from. */
  convertedFrom?: string
  /** Content identity; the same digest in two agents' folders is one skill shown on one row. */
  digest?: string
  included: boolean
  state: 'synced' | 'skipped' | 'pending'
  skipReason?: AgentConfigSkipReason
  outcome?: AgentConfigPlanOutcome | AgentConfigPutOutcome
}

export type AgentConfigSyncStatus = {
  environmentId: string
  running: boolean
  lastSyncedAt: number | null
  error: 'host-outdated' | 'host-unreachable' | 'failed' | null
  rows: AgentConfigSyncRow[]
}

export type CloudAgentConfigSyncPreferences = {
  /** Sync on every connect (create and wake) to an Orca Cloud workspace. */
  autoSync: boolean
  /** Also give Codex the Claude Code skills and commands, and Claude Code the Codex ones. */
  shareAcrossAgents: boolean
  /** Item keys the user turned off. */
  excluded: string[]
  /** Keys of opt-in items (memory) the user turned on. */
  optedIn: string[]
}

export const CLOUD_AGENT_CONFIG_SYNC_CHANGED_CHANNEL = 'cloudAgentConfigSync:changed'
export const CLOUD_AGENT_CONFIG_SYNC_PREFERENCES_CHANNEL = 'cloudAgentConfigSync:preferences'
