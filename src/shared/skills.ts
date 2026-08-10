import { z } from 'zod'
import type { AgentType } from './agent-status-types'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'

export type SkillProvider = 'codex' | 'claude' | 'agent-skills'

export type SkillSourceKind = 'home' | 'repo' | 'bundled' | 'plugin'

export type DiscoveredSkill = {
  id: string
  name: string
  description: string | null
  providers: SkillProvider[]
  sourceKind: SkillSourceKind
  sourceLabel: string
  rootPath: string
  /** Every root that reached this file. Canonical-path dedup keeps one row but
   *  must not erase co-owning roots, or shared symlinked skills lose agents. */
  rootPaths?: string[]
  directoryPath: string
  skillFilePath: string
  installed: boolean
  fileCount: number
  updatedAt: number | null
}

export type SkillDiscoverySource = {
  id: string
  label: string
  path: string
  sourceKind: SkillSourceKind
  providers: SkillProvider[]
  /** Agent that owns this root; null is the explicit shared-skills scope. */
  owner: AgentType | null
  exists: boolean
  skippedReason?: 'missing' | 'remote-repo'
}

export type SkillDiscoveryResult = {
  skills: DiscoveredSkill[]
  sources: SkillDiscoverySource[]
  scannedAt: number
}

export type SkillDiscoveryTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  /** Workspace path whose local .agents/.claude skill roots should be scanned. */
  cwd?: string | null
  /** Lets the owning runtime resolve the project runtime from its own store
   *  when the caller (e.g. a remote client) cannot supply `projectRuntime`. */
  worktreeId?: string | null
  projectRuntime?: ProjectExecutionRuntimeResolution
}

const ResolvedProjectRuntimeSchema = z.object({
  status: z.literal('resolved'),
  runtime: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('local-host'),
      hostPlatform: z.string(),
      projectId: z.string(),
      reason: z.literal('non-windows'),
      cacheKey: z.string()
    }),
    z.object({
      kind: z.literal('windows-host'),
      hostPlatform: z.literal('win32'),
      projectId: z.string(),
      reason: z.enum(['project-override', 'global-default', 'migration-fallback']),
      cacheKey: z.string()
    }),
    z.object({
      kind: z.literal('wsl'),
      hostPlatform: z.literal('wsl'),
      projectId: z.string(),
      distro: z.string(),
      reason: z.enum(['project-override', 'global-default']),
      cacheKey: z.string()
    })
  ])
})

const RepairProjectRuntimeSchema = z.object({
  status: z.literal('repair-required'),
  repair: z.object({
    projectId: z.string(),
    preferredRuntime: z.object({ kind: z.literal('wsl'), distro: z.string().nullable() }),
    reason: z.enum(['wsl-unavailable', 'wsl-distro-required', 'wsl-distro-missing']),
    source: z.enum(['project-override', 'global-default']),
    cacheKey: z.string()
  })
})

/** Both desktop IPC and runtime RPC parse the complete discovery target here. */
export const SkillDiscoveryTargetSchema: z.ZodType<SkillDiscoveryTarget> = z.object({
  runtime: z.enum(['host', 'wsl']).optional(),
  wslDistro: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  worktreeId: z.string().nullable().optional(),
  projectRuntime: z
    .discriminatedUnion('status', [ResolvedProjectRuntimeSchema, RepairProjectRuntimeSchema])
    .optional()
})

export type PaneSkillDiscoveryTarget = {
  worktreeId: string
  /** Pane whose runtime-persisted startup directory should be scanned. */
  terminalTabId?: string
}

export const SKILL_DISCOVERY_LIMITS = {
  descriptionLength: 8192,
  nameLength: 512,
  pathLength: 4096,
  rootPaths: 64,
  skills: 5000,
  sources: 1000
} as const

/** Pane discovery carries workspace/pane identity only — never a path or SSH
 *  connection id. The owning runtime derives the scan directory from its own
 *  persisted state. */
export const PaneSkillDiscoveryTargetSchema: z.ZodType<PaneSkillDiscoveryTarget> = z.object({
  worktreeId: z
    .string()
    .min(1)
    .max(SKILL_DISCOVERY_LIMITS.pathLength + 512),
  terminalTabId: z.string().min(1).max(512).optional()
})

/** Relay upgrade is a typed payload, not an error: old runtimes strip unknown
 *  request fields and old relays answer -32601, so clients must never have to
 *  string-match error messages to detect version skew. */
export type SkillDiscoveryForPaneResponse =
  | { status: 'ok'; result: SkillDiscoveryResult }
  | { status: 'relay-upgrade-required' }

const SKILL_PROVIDER_VALUES = ['codex', 'claude', 'agent-skills'] as const
const SKILL_SOURCE_KIND_VALUES = ['home', 'repo', 'bundled', 'plugin'] as const

const boundedString = (max: number): z.ZodString => z.string().max(max)

/** Validates untrusted skill metadata at the SSH relay boundary before it can
 *  enter renderer state: bounded strings, known enums, finite numbers. */
export const SkillDiscoveryResultSchema = z.object({
  skills: z
    .array(
      z.object({
        id: boundedString(512),
        name: boundedString(SKILL_DISCOVERY_LIMITS.nameLength),
        description: boundedString(SKILL_DISCOVERY_LIMITS.descriptionLength).nullable(),
        providers: z.array(z.enum(SKILL_PROVIDER_VALUES)).max(8),
        sourceKind: z.enum(SKILL_SOURCE_KIND_VALUES),
        sourceLabel: boundedString(1024),
        rootPath: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        rootPaths: z
          .array(boundedString(SKILL_DISCOVERY_LIMITS.pathLength))
          .max(SKILL_DISCOVERY_LIMITS.rootPaths)
          .optional(),
        directoryPath: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        skillFilePath: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        installed: z.boolean(),
        fileCount: z.number().int().min(0).max(1_000_000),
        updatedAt: z.number().finite().nullable()
      })
    )
    .max(SKILL_DISCOVERY_LIMITS.skills),
  sources: z
    .array(
      z.object({
        id: boundedString(512),
        label: boundedString(1024),
        path: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        sourceKind: z.enum(SKILL_SOURCE_KIND_VALUES),
        providers: z.array(z.enum(SKILL_PROVIDER_VALUES)).max(8),
        owner: boundedString(64).nullable(),
        exists: z.boolean(),
        skippedReason: z.enum(['missing', 'remote-repo']).optional()
      })
    )
    .max(SKILL_DISCOVERY_LIMITS.sources),
  scannedAt: z.number().finite()
})

export function parseSkillDiscoveryResult(value: unknown): SkillDiscoveryResult {
  // Why: an unrecognized source owner only fails provider filtering, so the
  // schema keeps owner as a bounded string rather than pinning AgentType.
  return SkillDiscoveryResultSchema.parse(value) as SkillDiscoveryResult
}

export type SkillFrontmatterSummary = {
  name: string | null
  description: string | null
}
