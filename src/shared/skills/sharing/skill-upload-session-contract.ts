import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { SkillPackageIdentitySchema } from '../installation/skill-install-contract'
import { SkillBundlePackageIdentitySchema } from '../installation/skill-bundle-install-contract'

export const SKILL_UPLOAD_CHUNK_MAX_BYTES = 256 * 1024

export const SkillUploadBeginRequestSchema = lazyZodSchema(() =>
  z
    .object({
      package: z.union([SkillPackageIdentitySchema, SkillBundlePackageIdentitySchema]),
      transferId: z.string().min(1).max(128).optional()
    })
    .strict()
)

export const SkillUploadBeginResultSchema = lazyZodSchema(() =>
  z.object({
    uploadId: z.string().min(1).max(128),
    chunkBytes: z.number().int().positive(),
    acknowledgedOffset: z.number().int().nonnegative().optional().default(0)
  })
)

export const SkillUploadChunkRequestSchema = lazyZodSchema(() =>
  z
    .object({
      uploadId: z.string().min(1).max(128),
      offset: z.number().int().nonnegative(),
      bytesBase64: z.string().max(Math.ceil(SKILL_UPLOAD_CHUNK_MAX_BYTES / 3) * 4 + 8)
    })
    .strict()
)

export const SkillUploadCommitRequestSchema = lazyZodSchema(() =>
  z.object({ uploadId: z.string().min(1).max(128) }).strict()
)

export type SkillUploadBeginRequest = z.infer<typeof SkillUploadBeginRequestSchema>
export type SkillUploadBeginResult = z.infer<typeof SkillUploadBeginResultSchema>
export type SkillUploadChunkRequest = z.infer<typeof SkillUploadChunkRequestSchema>
