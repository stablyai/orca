import { z } from 'zod'
import { MobileWebTaskLinearIssueSchema } from './task-list-contract'

const TargetIdSchema = z.string().min(1).max(128)
const WorkspaceIdSchema = z.string().min(1).max(160)
const TeamIdSchema = z.string().min(1).max(160)
const BodySchema = z
  .string()
  .trim()
  .min(1)
  .max(64 * 1024)

export const MobileWebTaskLinearConnectPayloadSchema = z
  .object({ apiKey: z.string().trim().min(1).max(4_096) })
  .strict()
export const MobileWebTaskLinearEmptyPayloadSchema = z.object({}).strict()
export const MobileWebTaskLinearWorkspacePayloadSchema = z
  .object({ workspaceId: WorkspaceIdSchema })
  .strict()
export const MobileWebTaskLinearTargetPayloadSchema = z
  .object({ targetId: TargetIdSchema })
  .strict()
export const MobileWebTaskLinearStateUpdatePayloadSchema = z
  .object({ targetId: TargetIdSchema, stateId: z.string().min(1).max(160) })
  .strict()
export const MobileWebTaskLinearCommentPayloadSchema = z
  .object({ targetId: TargetIdSchema, body: BodySchema })
  .strict()
export const MobileWebTaskLinearSubIssuePayloadSchema = z
  .object({ targetId: TargetIdSchema, title: z.string().trim().min(1).max(2_000) })
  .strict()
export const MobileWebTaskLinearCreatePayloadSchema = z
  .object({
    teamId: TeamIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    title: z.string().trim().min(1).max(2_000),
    description: z
      .string()
      .max(64 * 1024)
      .optional()
  })
  .strict()

export const MobileWebTaskLinearTeamSchema = z
  .object({
    id: TeamIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    workspaceName: z.string().max(240).optional(),
    name: z.string().min(1).max(240),
    key: z.string().min(1).max(80)
  })
  .strict()
export const MobileWebTaskLinearTeamsResultSchema = z
  .object({ teams: z.array(MobileWebTaskLinearTeamSchema).max(10_000) })
  .strict()

export const MobileWebTaskLinearStateSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().max(240),
    type: z.string().max(80),
    color: z.string().max(64).optional()
  })
  .strict()
export const MobileWebTaskLinearStatesResultSchema = z
  .object({ states: z.array(MobileWebTaskLinearStateSchema).max(1_000) })
  .strict()

export const MobileWebTaskLinearCommentResultSchema = z
  .object({ id: z.string().min(1).max(240).optional() })
  .strict()
export const MobileWebTaskLinearIssueResultSchema = z
  .object({ issue: MobileWebTaskLinearIssueSchema })
  .strict()
export const MobileWebTaskLinearCreatedIssueSchema = z
  .object({
    id: z.string().min(1).max(160),
    targetId: TargetIdSchema.optional(),
    identifier: z.string().min(1).max(160),
    title: z.string().max(2_000).optional(),
    url: z.string().url().max(4_096).optional()
  })
  .strict()
export const MobileWebTaskLinearCreatedIssueResultSchema = z
  .object({ issue: MobileWebTaskLinearCreatedIssueSchema })
  .strict()
export const MobileWebTaskLinearMutationResultSchema = z.null()

export type MobileWebTaskLinearConnectPayload = z.infer<
  typeof MobileWebTaskLinearConnectPayloadSchema
>
export type MobileWebTaskLinearWorkspacePayload = z.infer<
  typeof MobileWebTaskLinearWorkspacePayloadSchema
>
export type MobileWebTaskLinearStateUpdatePayload = z.infer<
  typeof MobileWebTaskLinearStateUpdatePayloadSchema
>
export type MobileWebTaskLinearCommentPayload = z.infer<
  typeof MobileWebTaskLinearCommentPayloadSchema
>
export type MobileWebTaskLinearSubIssuePayload = z.infer<
  typeof MobileWebTaskLinearSubIssuePayloadSchema
>
export type MobileWebTaskLinearCreatePayload = z.infer<
  typeof MobileWebTaskLinearCreatePayloadSchema
>
export type MobileWebTaskLinearTeam = z.infer<typeof MobileWebTaskLinearTeamSchema>
export type MobileWebTaskLinearState = z.infer<typeof MobileWebTaskLinearStateSchema>
export type MobileWebTaskLinearCreatedIssue = z.infer<typeof MobileWebTaskLinearCreatedIssueSchema>
