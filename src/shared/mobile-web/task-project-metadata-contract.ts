import { z } from 'zod'

export const MobileWebTaskProjectSlugPayloadSchema = z
  .object({
    owner: z.string().min(1).max(160),
    repo: z.string().min(1).max(240),
    host: z.string().min(1).max(253)
  })
  .strict()

export const MobileWebTaskProjectItemDetailPayloadSchema =
  MobileWebTaskProjectSlugPayloadSchema.extend({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.enum(['issue', 'pr'])
  }).strict()

export const MobileWebTaskProjectAssignableUsersPayloadSchema =
  MobileWebTaskProjectSlugPayloadSchema.extend({
    seedLogins: z.array(z.string().min(1).max(160)).max(1_000).optional()
  }).strict()

export const MobileWebTaskProjectIssueTypesResultSchema = z
  .object({
    types: z
      .array(
        z
          .object({
            id: z.string().min(1).max(240),
            name: z.string().max(512),
            color: z.string().max(64).nullable(),
            description: z.string().max(4_096).nullable()
          })
          .strict()
      )
      .max(1_000)
  })
  .strict()

export type MobileWebTaskProjectSlugPayload = z.infer<typeof MobileWebTaskProjectSlugPayloadSchema>
export type MobileWebTaskProjectItemDetailPayload = z.infer<
  typeof MobileWebTaskProjectItemDetailPayloadSchema
>
export type MobileWebTaskProjectAssignableUsersPayload = z.infer<
  typeof MobileWebTaskProjectAssignableUsersPayloadSchema
>
export type MobileWebTaskProjectIssueType = z.infer<
  typeof MobileWebTaskProjectIssueTypesResultSchema
>['types'][number]
