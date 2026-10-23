import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

const ClickUpPriority = z.number().int().min(1).max(4)

const ClickUpDueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const ClickUpConnect = z.object({
  apiToken: requiredString('Personal API token is required')
})

export const ClickUpSelectWorkspace = z.object({
  workspaceId: requiredString('Workspace ID is required')
})

export const ClickUpWorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

// listId narrows the read to one List, for callers that only need its statuses.
// spaceId walks only that Space.
export const ClickUpListLists = z
  .object({
    workspaceId: OptionalString,
    listId: OptionalString,
    spaceId: OptionalString
  })
  .optional()

const ClickUpTaskScopeParams = z
  .object({
    spaceId: OptionalString,
    listIds: z.array(z.string()).max(50).optional(),
    statuses: z.array(z.string()).max(50).optional()
  })
  .optional()

export const ClickUpSearchTasks = z.object({
  query: requiredString('Search query is required'),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString,
  scope: ClickUpTaskScopeParams
})

export const ClickUpListTasks = z
  .object({
    filter: z.enum(['assigned', 'created', 'all', 'completed', 'open']).optional(),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString,
    scope: ClickUpTaskScopeParams
  })
  .optional()

export const ClickUpTaskId = z.object({
  taskId: requiredString('Task ID is required'),
  workspaceId: OptionalString
})

export const ClickUpCreateTask = z.object({
  workspaceId: OptionalString,
  listId: requiredString('List is required'),
  name: requiredString('Task name is required'),
  description: z.string().optional(),
  status: OptionalString,
  priority: ClickUpPriority.nullish(),
  dueDate: ClickUpDueDate.optional(),
  timeEstimate: z.number().nonnegative().optional(),
  assigneeIds: z.array(z.number()).optional(),
  tagNames: z.array(z.string()).optional(),
  parentTaskId: OptionalString
})

export const ClickUpTaskUpdate = z.object({
  taskId: requiredString('Task ID is required'),
  workspaceId: OptionalString,
  updates: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: ClickUpPriority.nullish(),
    dueDate: ClickUpDueDate.nullish(),
    timeEstimate: z.number().nonnegative().nullish(),
    assigneeIds: z.array(z.number()).optional(),
    tagNames: z.array(z.string()).optional()
  })
})

export const ClickUpTaskComment = z.object({
  taskId: requiredString('Task ID is required'),
  body: requiredString('Comment is required'),
  workspaceId: OptionalString
})
