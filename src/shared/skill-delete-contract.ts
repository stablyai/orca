import { z } from 'zod'
import { SkillDiscoveryTargetSchema } from './skills'

/** Why a closed vocabulary: the result band groups skips by reason, and a remote
 *  host cannot localize free-text prose for the client that renders it. */
export const SKILL_DELETE_BLOCK_REASONS = [
  'bundled',
  'plugin',
  'unowned',
  'missing',
  'stale'
] as const
export type SkillDeleteBlockReason = (typeof SKILL_DELETE_BLOCK_REASONS)[number]

export const SKILL_DELETE_PLACEMENT_KINDS = ['canonical', 'alias-dir', 'alias-file'] as const
export type SkillDeletePlacementKind = (typeof SKILL_DELETE_PLACEMENT_KINDS)[number]

export const SKILL_DELETE_STATUSES = ['deleted', 'skipped', 'partial', 'failed', 'busy'] as const
export type SkillDeleteStatus = (typeof SKILL_DELETE_STATUSES)[number]

/** One page of rows; a selection larger than this is not a thing the UI offers. */
export const MAX_SKILL_DELETE_BATCH = 512

const SkillPathSchema = z.string().min(1).max(4096)

const SkillDeleteTargetSkillSchema = z
  .object({
    /** `DiscoveredSkill.id` — identity, so host and client agree without
     *  re-deriving it from a path that may have just been renamed. */
    id: z.string().min(1).max(128),
    directoryPath: SkillPathSchema,
    skillFilePath: SkillPathSchema,
    name: z.string().min(1).max(256),
    /** `stat(skillFilePath).mtimeMs` as displayed; null fails the guard closed. */
    updatedAt: z.number().nullable()
  })
  .strict()

/** Strict on purpose (matching `SkillInstallRequestSchema`): an old host must
 *  reject a field that would change what gets deleted, not ignore it. */
export const SkillDeleteRequestSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    // Send exactly what the scan sent — usually nothing.
    target: SkillDiscoveryTargetSchema.optional(),
    skills: z.array(SkillDeleteTargetSkillSchema).min(1).max(MAX_SKILL_DELETE_BATCH)
  })
  .strict()

export type SkillDeleteRequest = z.infer<typeof SkillDeleteRequestSchema>
export type SkillDeleteTargetSkill = z.infer<typeof SkillDeleteTargetSkillSchema>

export type SkillDeletePlacement = {
  path: string
  kind: SkillDeletePlacementKind
  rootLabel: string
}

export type SkillDeletePlanEntry = {
  id: string
  name: string
  /** realpath of `skillFilePath`. NOT the lock key — see the delete service. */
  canonicalPath: string
  placements: SkillDeletePlacement[]
  blocked?: SkillDeleteBlockReason
}

export type SkillDeletePlan = {
  operationId: string
  skills: SkillDeletePlanEntry[]
}

export type SkillDeleteResultEntry = {
  id: string
  name: string
  status: SkillDeleteStatus
  /** Present when status is 'skipped'; same vocabulary as the plan. */
  blocked?: SkillDeleteBlockReason
  removedPaths: string[]
  /** Present when status is 'partial'. */
  stagedPaths?: string[]
}

export type SkillDeleteResult = {
  operationId: string
  skills: SkillDeleteResultEntry[]
}

const SkillDeletePlacementSchema = z.object({
  path: SkillPathSchema,
  kind: z.enum(SKILL_DELETE_PLACEMENT_KINDS),
  rootLabel: z.string().max(256)
})

export const SkillDeletePlanSchema: z.ZodType<SkillDeletePlan> = z.object({
  operationId: z.string().min(1).max(128),
  skills: z.array(
    z.object({
      id: z.string().min(1).max(128),
      name: z.string().max(256),
      canonicalPath: SkillPathSchema,
      placements: z.array(SkillDeletePlacementSchema).max(64),
      blocked: z.enum(SKILL_DELETE_BLOCK_REASONS).optional()
    })
  )
})

export const SkillDeleteResultSchema: z.ZodType<SkillDeleteResult> = z.object({
  operationId: z.string().min(1).max(128),
  skills: z.array(
    z.object({
      id: z.string().min(1).max(128),
      name: z.string().max(256),
      status: z.enum(SKILL_DELETE_STATUSES),
      blocked: z.enum(SKILL_DELETE_BLOCK_REASONS).optional(),
      removedPaths: z.array(SkillPathSchema).max(64),
      stagedPaths: z.array(SkillPathSchema).max(64).optional()
    })
  )
})
