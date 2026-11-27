import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { ITSAPLAN_LIST_LIMIT_MAX } from '../../itsaplan/itsaplan-types'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../rpc-param-primitives'

const StateType = lazyZodSchema(() =>
  z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled'])
)

const IssueIdValue = lazyZodSchema(() => z.number().int().positive())

const ClampedLimit = lazyZodSchema(() =>
  OptionalFiniteNumber.transform((value) =>
    value === undefined
      ? undefined
      : Math.min(ITSAPLAN_LIST_LIMIT_MAX, Math.max(1, Math.floor(value)))
  )
)

export const DetectApiUrl = lazyZodSchema(() =>
  z.object({
    appUrl: requiredString('App URL is required')
  })
)

export const Connect = lazyZodSchema(() =>
  z.object({
    appUrl: requiredString('App URL is required'),
    apiUrl: OptionalString,
    apiKey: requiredString('API key is required')
  })
)

export const ListProjects = lazyZodSchema(() => z.object({ query: OptionalPlainString }).optional())

export const ProjectRef = lazyZodSchema(() =>
  z.object({
    projectRef: requiredString('Project is required')
  })
)

export const ListIssues = lazyZodSchema(() =>
  z.object({
    projectRef: requiredString('Project is required'),
    filters: z.object({
      stateTypes: z.array(StateType).optional(),
      assignee: z
        .union([
          z.enum(['me', 'unassigned']),
          z.object({ userId: requiredString('User is required') })
        ])
        .optional(),
      labelIds: z.array(z.number().int()).optional()
    }),
    search: OptionalPlainString,
    limit: ClampedLimit
  })
)

export const IssueId = lazyZodSchema(() =>
  z.object({ issueId: IssueIdValue, projectRef: OptionalString })
)

export const CreateIssue = lazyZodSchema(() =>
  z.object({
    projectRef: requiredString('Project is required'),
    title: requiredString('Title is required'),
    description: OptionalPlainString,
    columnId: OptionalFiniteNumber,
    priority: z.union([z.string(), z.null()]).optional(),
    labelIds: z.array(z.number().int()).optional(),
    assigneeUserId: z.union([z.string(), z.null()]).optional(),
    parentId: z.union([z.number().int(), z.null()]).optional()
  })
)

export const UpdateIssue = lazyZodSchema(() =>
  z.object({
    issueId: IssueIdValue,
    projectRef: OptionalString,
    updates: z.object({
      title: OptionalString,
      description: OptionalPlainString,
      columnId: OptionalFiniteNumber,
      priority: z.union([z.string(), z.null()]).optional(),
      labelIds: z.array(z.number().int()).optional(),
      assigneeUserId: z.union([z.string(), z.null()]).optional()
    })
  })
)

export const AddComment = lazyZodSchema(() =>
  z.object({
    issueId: IssueIdValue,
    body: requiredString('Comment body is required')
  })
)
