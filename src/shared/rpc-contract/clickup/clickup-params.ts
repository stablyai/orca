import { z } from 'zod'
import {
  CLICKUP_PAGE_RANGE_MESSAGE,
  isClickUpPageIndex,
  normalizeClickUpTaskListFilter
} from '../../clickup/clickup-task-filter'
import { OptionalString, requiredString } from '../rpc-param-primitives'

const ClickUpTaskListFilterParam = z.unknown().transform(normalizeClickUpTaskListFilter).optional()
const ClickUpPageParam = z
  .number()
  .refine(isClickUpPageIndex, { message: CLICKUP_PAGE_RANGE_MESSAGE })
  .nullish()

export const ClickUpConnectParams = z.object({
  token: requiredString('API token is required')
})

export const ClickUpSelectWorkspaceParams = z.object({
  workspaceId: requiredString('Workspace ID is required')
})

export const ClickUpListTasksParams = z
  .object({
    filter: ClickUpTaskListFilterParam,
    page: ClickUpPageParam
  })
  .optional()

export const ClickUpSearchTasksParams = z.object({
  query: requiredString('Missing search query'),
  filter: ClickUpTaskListFilterParam,
  fresh: z.boolean().optional()
})

export const ClickUpTaskIdParams = z.object({
  id: requiredString('Task id is required')
})

export const ClickUpAddTaskCommentParams = z.object({
  id: requiredString('Task id is required'),
  body: requiredString('Comment body is required')
})

export const ClickUpListStatusesParams = z.object({
  listId: requiredString('List id is required')
})

export const ClickUpUpdateTaskParams = z.object({
  id: requiredString('Task id is required'),
  updates: z.object({
    status: OptionalString
  })
})
