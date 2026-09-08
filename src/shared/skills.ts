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
  /** `unavailable`: the root did not answer in time, so its skills are unknown rather than absent. */
  skippedReason?: 'missing' | 'remote-repo' | 'unavailable'
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
  /** Bypass the host's shared scans because the caller knows disk just changed.
   *  Optional so an older host simply ignores it and scans as it always did. */
  refresh?: boolean
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
    .optional(),
  refresh: z.boolean().optional()
})

export const SKILL_DISCOVERY_LIMITS = {
  descriptionLength: 8192,
  nameLength: 512,
  pathLength: 4096,
  rootPaths: 64,
  skills: 5000,
  sources: 1000
} as const

const SKILL_PROVIDER_VALUES = ['codex', 'claude', 'agent-skills'] as const
const SKILL_SOURCE_KIND_VALUES = ['home', 'repo', 'bundled', 'plugin'] as const

/** Identity and paths must be well-formed to be usable, so an over-long one is
 *  rejected rather than truncated into a different path. */
const boundedString = (max: number): z.ZodString => z.string().max(max)

/** Free text is display-only, so an over-long value is clamped rather than
 *  failing the whole scan — a remote user's genuinely long description must not
 *  empty their picker, while a hostile host still cannot grow renderer state. */
const clampedString = (max: number): z.ZodType<string> =>
  z.string().transform((value) => (value.length > max ? value.slice(0, max) : value))

/** Validates untrusted skill metadata at the SSH relay boundary before it can
 *  enter renderer state.
 *
 *  Field-for-field with `DiscoveredSkill`/`SkillDiscoverySource` above —
 *  `discovery-wire-contract.test.ts` parses a real scan so the two cannot drift.
 */
export const SkillDiscoveryResultSchema = z.object({
  skills: z
    .array(
      z.object({
        id: boundedString(512),
        name: clampedString(SKILL_DISCOVERY_LIMITS.nameLength),
        description: clampedString(SKILL_DISCOVERY_LIMITS.descriptionLength).nullable(),
        providers: z.array(z.enum(SKILL_PROVIDER_VALUES)).max(8),
        sourceKind: z.enum(SKILL_SOURCE_KIND_VALUES),
        sourceLabel: clampedString(1024),
        rootPath: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        rootPaths: z
          .array(boundedString(SKILL_DISCOVERY_LIMITS.pathLength))
          .max(SKILL_DISCOVERY_LIMITS.rootPaths)
          .optional(),
        directoryPath: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        skillFilePath: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        installed: z.boolean(),
        updatedAt: z.number().finite().nullable()
      })
    )
    .max(SKILL_DISCOVERY_LIMITS.skills),
  sources: z
    .array(
      z.object({
        id: boundedString(512),
        label: clampedString(1024),
        path: boundedString(SKILL_DISCOVERY_LIMITS.pathLength),
        sourceKind: z.enum(SKILL_SOURCE_KIND_VALUES),
        providers: z.array(z.enum(SKILL_PROVIDER_VALUES)).max(8),
        owner: boundedString(64).nullable(),
        exists: z.boolean(),
        skippedReason: z.enum(['missing', 'remote-repo', 'unavailable']).optional()
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
