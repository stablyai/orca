import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const LinearRunIntakeSchema = lazyZodSchema(() =>
  z.object({
    sourceWorkspaceId: z.string().uuid(),
    sourceIssueKey: z.string().nullable(),
    sourceIssueId: z.string().uuid(),
    sourceProjectId: z.string().uuid().nullable(),
    configuredBotId: z.string().uuid(),
    assignedProjectId: z.string().uuid().nullable(),
    ruleRevision: z.number().int().nonnegative(),
    receivingBotId: z.string().uuid()
  })
)
export type LinearRunIntake = z.infer<typeof LinearRunIntakeSchema>
export type LinearIssueIntake = Omit<LinearRunIntake, 'receivingBotId'>
