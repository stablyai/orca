import { z } from 'zod'

const WorkspaceIdSchema = z.string().min(1).max(160)
const TeamIdSchema = z.string().min(1).max(160)

export const MobileWebTaskLinearTeamSchema = z
  .object({
    id: TeamIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    workspaceName: z.string().max(240).optional(),
    name: z.string().min(1).max(240),
    key: z.string().min(1).max(80)
  })
  .strict()
export const MobileWebTaskLinearStateSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().max(240),
    type: z.string().max(80),
    color: z.string().max(64).optional()
  })
  .strict()
export const MobileWebTaskLinearCreatedIssueSchema = z
  .object({
    id: z.string().min(1).max(160),
    identifier: z.string().min(1).max(160),
    title: z.string().max(2_000).optional(),
    url: z.string().url().max(4_096).optional()
  })
  .strict()
export type MobileWebTaskLinearTeam = z.infer<typeof MobileWebTaskLinearTeamSchema>
export type MobileWebTaskLinearState = z.infer<typeof MobileWebTaskLinearStateSchema>
export type MobileWebTaskLinearCreatedIssue = z.infer<typeof MobileWebTaskLinearCreatedIssueSchema>
