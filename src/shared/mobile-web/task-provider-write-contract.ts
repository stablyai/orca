import { z } from 'zod'

const RepoIdSchema = z.string().min(1).max(128)

export const MobileWebTaskProviderIssueCreatePayloadSchema = z
  .object({
    provider: z.enum(['github', 'gitlab']),
    repoId: RepoIdSchema,
    title: z.string().trim().min(1).max(2_000),
    body: z.string().max(64 * 1024)
  })
  .strict()
export const MobileWebTaskProviderIssueCreateResultSchema = z
  .object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    url: z.string().url().max(4_096).optional()
  })
  .strict()
export const MobileWebTaskIssueSourcePayloadSchema = z
  .object({
    repoId: RepoIdSchema,
    preference: z.enum(['upstream', 'origin'])
  })
  .strict()
export const MobileWebTaskProviderMutationResultSchema = z.null()

export type MobileWebTaskProviderIssueCreatePayload = z.infer<
  typeof MobileWebTaskProviderIssueCreatePayloadSchema
>
export type MobileWebTaskIssueSourcePayload = z.infer<typeof MobileWebTaskIssueSourcePayloadSchema>
