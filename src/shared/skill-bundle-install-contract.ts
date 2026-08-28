import { z } from 'zod'
import { SkillInstallDestinationSchema } from './skill-install-contract'
import { SkillInstallFailureSchema, type SkillInstallFailure } from './skill-install-failure'

const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const ID_SCHEMA = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const SKILL_NAME_SCHEMA = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

export const SkillBundlePackageIdentitySchema = z
  .object({
    packageId: ID_SCHEMA,
    versionId: ID_SCHEMA,
    bundleDigest: z.string().regex(DIGEST_PATTERN),
    archiveSha256: z.string().regex(DIGEST_PATTERN),
    compressedBytes: z
      .number()
      .int()
      .positive()
      .max(40 * 1024 * 1024)
  })
  .strict()

const SkillBundleInstallIngressSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('download-grant'),
      url: z.url(),
      expiresAt: z.iso.datetime({ offset: true })
    })
    .strict(),
  z.object({ kind: z.literal('staged-upload'), uploadId: ID_SCHEMA }).strict(),
  z.object({ kind: z.literal('local-file'), path: z.string().min(1) }).strict()
])

export const SkillBundleSelectedSkillSchema = z
  .object({ id: ID_SCHEMA, name: SKILL_NAME_SCHEMA, digest: z.string().regex(DIGEST_PATTERN) })
  .strict()

const SkillBundleConflictDecisionSchema = z
  .object({
    skillId: ID_SCHEMA,
    resolution: z.enum(['keep-local', 'replace-unmodified', 'replace-and-discard-local'])
  })
  .strict()

function hasUniqueSkillIds(values: readonly { id?: string; skillId?: string }[]): boolean {
  const ids = values.map((value) => value.id ?? value.skillId)
  return new Set(ids).size === ids.length
}

export const SkillBundleInstallRequestSchema = z
  .object({
    operationId: ID_SCHEMA,
    package: SkillBundlePackageIdentitySchema,
    selectedSkillIds: z.array(ID_SCHEMA).min(1).max(512),
    ingress: SkillBundleInstallIngressSchema,
    destination: SkillInstallDestinationSchema,
    /** Agents the user picked; absent means every detected agent. */
    providers: z.array(z.string().min(1).max(64)).max(64).optional(),
    conflictDecisions: z.array(SkillBundleConflictDecisionSchema).max(512).default([])
  })
  .strict()
  .refine((value) => new Set(value.selectedSkillIds).size === value.selectedSkillIds.length, {
    message: 'skill-bundle-selection-duplicate'
  })
  .refine((value) => hasUniqueSkillIds(value.conflictDecisions), {
    message: 'skill-bundle-conflict-decision-duplicate'
  })
  .refine(
    (value) =>
      value.conflictDecisions.every((decision) =>
        value.selectedSkillIds.includes(decision.skillId)
      ),
    { message: 'skill-bundle-conflict-decision-unselected' }
  )

export const SkillBundleInstallPreviewRequestSchema = z
  .object({
    package: SkillBundlePackageIdentitySchema,
    selectedSkills: z.array(SkillBundleSelectedSkillSchema).min(1).max(512),
    destination: SkillInstallDestinationSchema
  })
  .strict()
  .refine((value) => hasUniqueSkillIds(value.selectedSkills), {
    message: 'skill-bundle-selection-duplicate'
  })

const SkillBundleCurrentStateSchema = z.enum([
  'missing',
  'unchanged',
  'clean-update',
  'modified',
  'unowned',
  'external-link',
  'name-collision'
])

export const SkillBundleInstallPreviewSchema = z.object({
  packageId: ID_SCHEMA,
  versionId: ID_SCHEMA,
  bundleDigest: z.string().regex(DIGEST_PATTERN),
  destinationIdentity: z.string(),
  skills: z.array(
    SkillBundleSelectedSkillSchema.extend({ currentState: SkillBundleCurrentStateSchema })
  )
})

const SkillBundlePlacementResultSchema = z.object({
  provider: z.string(),
  path: z.string(),
  topology: z.enum(['canonical-copy', 'provider-alias', 'independent-copy']),
  status: z.enum(['installed', 'unchanged', 'skipped', 'failed']),
  errorCategory: z.string().optional(),
  failure: SkillInstallFailureSchema.optional()
})

export const SkillBundleInstallResultSchema = z.object({
  operationId: ID_SCHEMA,
  packageId: ID_SCHEMA,
  versionId: ID_SCHEMA,
  bundleDigest: z.string().regex(DIGEST_PATTERN),
  status: z.enum(['complete', 'partial', 'cancelled', 'failed']),
  skills: z.array(
    z.object({
      skillId: ID_SCHEMA,
      name: SKILL_NAME_SCHEMA,
      digest: z.string().regex(DIGEST_PATTERN),
      status: z.enum(['installed', 'updated', 'unchanged', 'kept-local', 'failed', 'cancelled']),
      canonicalPath: z.string().optional(),
      placements: z.array(SkillBundlePlacementResultSchema),
      conflict: z
        .object({
          kind: z.enum(['modified', 'unowned', 'external-link', 'name-collision']),
          existingDigest: z.string().optional()
        })
        .optional(),
      errorCategory: z.string().optional(),
      failure: SkillInstallFailureSchema.optional()
    })
  )
})

export type SkillBundlePackageIdentity = z.infer<typeof SkillBundlePackageIdentitySchema>
export type SkillBundleSelectedSkill = z.infer<typeof SkillBundleSelectedSkillSchema>
export type SkillBundleInstallRequest = z.infer<typeof SkillBundleInstallRequestSchema>
export type SkillBundleInstallPreviewRequest = z.infer<
  typeof SkillBundleInstallPreviewRequestSchema
>
export type SkillBundleInstallPreview = z.infer<typeof SkillBundleInstallPreviewSchema>
export type SkillBundleInstallResult = z.infer<typeof SkillBundleInstallResultSchema>
export type SkillBundleSkillResult = SkillBundleInstallResult['skills'][number]
export type SkillBundlePlacementResult = SkillBundleSkillResult['placements'][number]
export type SkillBundleInstallFailure = SkillInstallFailure

export const SkillBundleInstallProgressSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    skillId: z.string().min(1).max(128),
    skillName: z.string().min(1).max(128),
    skillIndex: z.number().int().min(1).max(512),
    skillCount: z.number().int().min(1).max(512)
  })
  .strict()

export type SkillBundleInstallProgress = z.infer<typeof SkillBundleInstallProgressSchema>
