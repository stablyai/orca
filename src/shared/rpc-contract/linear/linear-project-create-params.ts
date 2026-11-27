import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalString, requiredString } from '../rpc-param-primitives'

export const LinearPriority = lazyZodSchema(() => z.number().int().min(0).max(4).optional())

export const LinearLabelIds = lazyZodSchema(() =>
  z.array(requiredString('Invalid label ID')).optional()
)

export const CreateProject = lazyZodSchema(() =>
  z.object({
    name: requiredString('Project name is required'),
    description: OptionalString,
    content: OptionalString,
    workspaceId: OptionalString,
    teamIds: z.array(requiredString('Invalid team ID')).min(1, 'At least one team is required'),
    leadId: z.union([z.string(), z.null()]).optional(),
    memberIds: z.array(requiredString('Invalid member ID')).optional(),
    labelIds: LinearLabelIds,
    priority: LinearPriority,
    startDate: OptionalString,
    targetDate: OptionalString
  })
)
