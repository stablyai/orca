import { z } from 'zod'

const HostSchema = z.string().min(1).max(253)
const OwnerSchema = z.string().min(1).max(160)
const ProjectNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const ProjectOwnerTypeSchema = z.enum(['organization', 'user'])
const ProjectLayoutSchema = z.enum(['TABLE_LAYOUT', 'BOARD_LAYOUT', 'ROADMAP_LAYOUT'])

export const MobileWebTaskProjectRefSchema = z
  .object({
    owner: OwnerSchema,
    ownerType: ProjectOwnerTypeSchema,
    number: ProjectNumberSchema,
    host: HostSchema.optional()
  })
  .strict()

export const MobileWebTaskProjectListPayloadSchema = z.object({ host: HostSchema }).strict()
export const MobileWebTaskProjectListResultSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            id: z.string().min(1).max(240),
            host: HostSchema,
            owner: OwnerSchema,
            ownerType: ProjectOwnerTypeSchema,
            number: ProjectNumberSchema,
            title: z.string().max(2_000),
            url: z.string().url().max(4_096),
            source: z.string().min(1).max(256)
          })
          .strict()
      )
      .max(2_000),
    partialFailures: z
      .array(
        z
          .object({
            owner: OwnerSchema,
            message: z.string().max(1_000)
          })
          .strict()
      )
      .max(1_000)
  })
  .strict()

export const MobileWebTaskProjectViewsPayloadSchema = MobileWebTaskProjectRefSchema
export const MobileWebTaskProjectViewsResultSchema = z
  .object({
    views: z
      .array(
        z
          .object({
            id: z.string().min(1).max(240),
            number: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            name: z.string().max(2_000),
            layout: ProjectLayoutSchema
          })
          .strict()
      )
      .max(1_000)
  })
  .strict()

export const MobileWebTaskProjectResolvePayloadSchema = z
  .object({
    input: z.string().min(1).max(4_096),
    host: HostSchema
  })
  .strict()
export const MobileWebTaskProjectResolveResultSchema = z
  .object({
    owner: OwnerSchema,
    ownerType: ProjectOwnerTypeSchema,
    number: ProjectNumberSchema,
    title: z.string().max(2_000),
    host: HostSchema.optional(),
    viewNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export type MobileWebTaskProjectRef = z.infer<typeof MobileWebTaskProjectRefSchema>
export type MobileWebTaskProjectListResult = z.infer<typeof MobileWebTaskProjectListResultSchema>
export type MobileWebTaskProjectView = z.infer<
  typeof MobileWebTaskProjectViewsResultSchema
>['views'][number]
export type MobileWebTaskProjectResolvePayload = z.infer<
  typeof MobileWebTaskProjectResolvePayloadSchema
>
export type MobileWebTaskProjectResolveResult = z.infer<
  typeof MobileWebTaskProjectResolveResultSchema
>
