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

export type SkillFrontmatterSummary = {
  name: string | null
  description: string | null
}
