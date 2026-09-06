import { z } from 'zod'
import { MobileWebHostedNullableAvatarUrlSchema } from './hosted-avatar-contract'
import { MobileWebTaskProjectRefSchema } from './task-project-read-contract'

export const MOBILE_WEB_TASK_PROJECT_PAGE_ROWS = 50
const IdentifierSchema = z.string().min(1).max(240)
const TextSchema = z.string().max(4_096)
const UrlSchema = z.string().url().max(4_096)

const ProjectOptionSchema = z
  .object({ id: IdentifierSchema, name: z.string().max(512), color: z.string().max(64) })
  .strict()
const ProjectIterationSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().max(512),
    startDate: z.string().max(64),
    duration: z.number().int().nonnegative().max(100_000),
    completed: z.boolean().optional()
  })
  .strict()

export const MobileWebTaskProjectFieldSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('field'),
      id: IdentifierSchema,
      name: z.string().max(512),
      dataType: z.string().max(80)
    })
    .strict(),
  z
    .object({
      kind: z.literal('single-select'),
      id: IdentifierSchema,
      name: z.string().max(512),
      dataType: z.literal('SINGLE_SELECT'),
      options: z.array(ProjectOptionSchema).max(1_000)
    })
    .strict(),
  z
    .object({
      kind: z.literal('iteration'),
      id: IdentifierSchema,
      name: z.string().max(512),
      dataType: z.literal('ITERATION'),
      iterations: z.array(ProjectIterationSchema).max(1_000)
    })
    .strict()
])

const ProjectUserSchema = z
  .object({
    login: z.string().min(1).max(160),
    name: z.string().max(240).nullable(),
    avatarUrl: MobileWebHostedNullableAvatarUrlSchema
  })
  .strip()
const ProjectLabelSchema = z
  .object({ name: z.string().max(240), color: z.string().max(64) })
  .strict()
const IssueTypeSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().max(512),
    color: z.string().max(64).nullable(),
    description: TextSchema.nullable()
  })
  .strict()

const ProjectFieldValueSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('single-select'),
      fieldId: IdentifierSchema,
      optionId: IdentifierSchema,
      name: z.string().max(512),
      color: z.string().max(64)
    })
    .strict(),
  z
    .object({
      kind: z.literal('iteration'),
      fieldId: IdentifierSchema,
      iterationId: IdentifierSchema,
      title: z.string().max(512),
      startDate: z.string().max(64),
      duration: z.number().int().nonnegative().max(100_000)
    })
    .strict(),
  z.object({ kind: z.literal('text'), fieldId: IdentifierSchema, text: TextSchema }).strict(),
  z
    .object({ kind: z.literal('number'), fieldId: IdentifierSchema, number: z.number().finite() })
    .strict(),
  z
    .object({ kind: z.literal('date'), fieldId: IdentifierSchema, date: z.string().max(64) })
    .strict(),
  z
    .object({
      kind: z.literal('labels'),
      fieldId: IdentifierSchema,
      labels: z.array(ProjectLabelSchema).max(1_000)
    })
    .strict(),
  z
    .object({
      kind: z.literal('users'),
      fieldId: IdentifierSchema,
      users: z.array(ProjectUserSchema).max(1_000)
    })
    .strict()
])

export const MobileWebTaskProjectRowSchema = z
  .object({
    id: IdentifierSchema,
    targetId: z.string().min(1).max(128).optional(),
    itemType: z.enum(['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE', 'REDACTED']),
    content: z
      .object({
        number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
        title: z.string().max(2_000),
        body: z
          .string()
          .max(64 * 1024)
          .nullable(),
        url: UrlSchema.nullable(),
        state: z.string().max(80).nullable(),
        stateReason: z.string().max(80).nullable().optional(),
        isDraft: z.boolean().nullable(),
        repository: z.string().max(512).nullable(),
        issueType: IssueTypeSchema.nullable().optional(),
        labels: z.array(ProjectLabelSchema).max(1_000),
        assignees: z.array(ProjectUserSchema).max(1_000),
        parentIssue: z
          .object({
            number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            title: z.string().max(2_000),
            url: UrlSchema
          })
          .strict()
          .nullable()
          .optional()
      })
      .strip(),
    fieldValuesByFieldId: z
      .record(IdentifierSchema, ProjectFieldValueSchema)
      .refine((value) => Object.keys(value).length <= 200),
    updatedAt: z.string().max(64),
    position: z.number().int().nonnegative().max(500)
  })
  .strict()

export const MobileWebTaskProjectFieldMutationValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: TextSchema }).strict(),
  z.object({ kind: z.literal('number'), number: z.number().finite() }).strict(),
  z.object({ kind: z.literal('date'), date: z.string().max(64) }).strict(),
  z.object({ kind: z.literal('single-select'), optionId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal('iteration'), iterationId: IdentifierSchema }).strict()
])

const ProjectViewSchema = z
  .object({
    id: IdentifierSchema,
    number: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    name: z.string().max(2_000),
    filter: z.string().max(4_096),
    layout: z.enum(['TABLE_LAYOUT', 'BOARD_LAYOUT', 'ROADMAP_LAYOUT']),
    fields: z.array(MobileWebTaskProjectFieldSchema).max(200),
    groupByFields: z.array(MobileWebTaskProjectFieldSchema).max(200),
    sortByFields: z
      .array(
        z
          .object({
            direction: z.enum(['ASC', 'DESC']),
            field: MobileWebTaskProjectFieldSchema
          })
          .strict()
      )
      .max(200)
  })
  .strict()

export const MobileWebTaskProjectTableSchema = z
  .object({
    project: MobileWebTaskProjectRefSchema.extend({
      id: IdentifierSchema,
      title: z.string().max(2_000),
      url: UrlSchema
    }).strict(),
    selectedView: ProjectViewSchema,
    rows: z.array(MobileWebTaskProjectRowSchema).max(500),
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    parentFieldDropped: z.boolean().optional()
  })
  .strict()

export const MobileWebTaskProjectTablePayloadSchema = MobileWebTaskProjectRefSchema.extend({
  viewId: IdentifierSchema,
  queryOverride: z.string().max(4_096).optional(),
  cursor: z.string().min(1).max(96).optional()
}).strict()

export const MobileWebTaskProjectTablePageResultSchema = z
  .object({
    project: MobileWebTaskProjectTableSchema.shape.project.optional(),
    selectedView: ProjectViewSchema.optional(),
    rows: z.array(MobileWebTaskProjectRowSchema).max(MOBILE_WEB_TASK_PROJECT_PAGE_ROWS),
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    parentFieldDropped: z.boolean().optional(),
    nextCursor: z.string().min(1).max(96).nullable()
  })
  .strict()

export type MobileWebTaskProjectTable = z.infer<typeof MobileWebTaskProjectTableSchema>
export type MobileWebTaskProjectTablePayload = z.infer<
  typeof MobileWebTaskProjectTablePayloadSchema
>
export type MobileWebTaskProjectTablePageResult = z.infer<
  typeof MobileWebTaskProjectTablePageResultSchema
>
export type MobileWebTaskProjectFieldMutationValue = z.infer<
  typeof MobileWebTaskProjectFieldMutationValueSchema
>
