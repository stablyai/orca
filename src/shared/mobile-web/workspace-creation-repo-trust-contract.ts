import { z } from 'zod'
import { isMobileWebSha256 } from './protocol-token-contract'

export const MobileWebCreationRepoIdSchema = z.string().min(1).max(128)

const TrustedHookEntrySchema = z
  .object({
    contentHash: z.string().refine(isMobileWebSha256),
    approvedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const TrustedHookRepoSchema = z
  .object({
    all: z
      .object({ approvedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .optional(),
    setup: TrustedHookEntrySchema.optional(),
    archive: TrustedHookEntrySchema.optional(),
    issueCommand: TrustedHookEntrySchema.optional(),
    vmRecipe: TrustedHookEntrySchema.optional()
  })
  .strict()

export const MobileWebCreationTrustedHooksResultSchema = z.record(
  MobileWebCreationRepoIdSchema,
  TrustedHookRepoSchema
)

export type MobileWebCreationTrustedHooksResult = z.infer<
  typeof MobileWebCreationTrustedHooksResultSchema
>
