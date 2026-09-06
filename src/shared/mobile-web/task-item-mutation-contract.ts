import { z } from 'zod'

const TargetIdSchema = z.string().min(1).max(128)
const NameSchema = z.string().min(1).max(240)

export const MobileWebTaskItemStatusPayloadSchema = z
  .object({ targetId: TargetIdSchema, closed: z.boolean() })
  .strict()

export const MobileWebTaskItemMetadataUpdatesSchema = z
  .object({
    title: z.string().min(1).max(2_000).optional(),
    body: z
      .string()
      .max(64 * 1024)
      .optional(),
    addLabels: z.array(NameSchema).max(100).optional(),
    removeLabels: z.array(NameSchema).max(100).optional(),
    addAssignees: z.array(NameSchema).max(100).optional(),
    removeAssignees: z.array(NameSchema).max(100).optional()
  })
  .strict()
  .refine((updates) => Object.values(updates).some((value) => value !== undefined))

export const MobileWebTaskItemMetadataPayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    updates: MobileWebTaskItemMetadataUpdatesSchema
  })
  .strict()

export const MobileWebTaskItemMutationResultSchema = z.null()

export type MobileWebTaskItemMetadataUpdates = z.infer<
  typeof MobileWebTaskItemMetadataUpdatesSchema
>
export type MobileWebTaskItemStatusPayload = z.infer<typeof MobileWebTaskItemStatusPayloadSchema>
export type MobileWebTaskItemMetadataPayload = z.infer<
  typeof MobileWebTaskItemMetadataPayloadSchema
>
