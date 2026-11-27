import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'

export const VALID_CUSTOM_VIEW_MODELS = ['issue', 'project'] as const

export const LinearPriority = lazyZodSchema(() => z.number().int().min(0).max(4).optional())

export const LinearLabelIds = lazyZodSchema(() =>
  z.array(requiredString('Invalid label ID')).optional()
)

export const Connect = lazyZodSchema(() =>
  z.object({
    apiKey: requiredString('Invalid API key')
  })
)

export const WorkspaceSelection = lazyZodSchema(() =>
  z
    .object({
      workspaceId: OptionalString
    })
    .optional()
)

export const ConcreteWorkspaceId = requiredString(
  'Concrete Linear workspace ID is required'
).refine((value) => value !== 'all', 'Concrete Linear workspace ID is required')

export const SelectWorkspace = lazyZodSchema(() =>
  z.object({
    workspaceId: requiredString('Workspace ID is required')
  })
)

export const SearchIssues = lazyZodSchema(() =>
  z.object({
    query: requiredString('Missing query'),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString
  })
)

export const CreateIssue = lazyZodSchema(() =>
  z.object({
    teamId: requiredString('Team ID is required'),
    title: requiredString('Title is required'),
    description: OptionalString,
    workspaceId: OptionalString,
    parentIssueId: OptionalString,
    projectId: z.union([z.string(), z.null()]).optional(),
    stateId: OptionalString,
    priority: LinearPriority,
    assigneeId: z.union([z.string(), z.null()]).optional(),
    labelIds: LinearLabelIds
  })
)

export const IssueId = lazyZodSchema(() =>
  z.object({
    id: requiredString('Issue ID is required'),
    workspaceId: OptionalString
  })
)

export const IssueComment = lazyZodSchema(() =>
  z.object({
    issueId: requiredString('Issue ID is required'),
    body: requiredString('Comment body is required'),
    workspaceId: OptionalString
  })
)

export const ListProjects = lazyZodSchema(() =>
  z
    .object({
      query: OptionalString,
      limit: OptionalFiniteNumber,
      workspaceId: OptionalString,
      force: z.boolean().optional()
    })
    .optional()
)

export const ProjectId = lazyZodSchema(() =>
  z.object({
    id: requiredString('Project ID is required'),
    workspaceId: ConcreteWorkspaceId,
    force: z.boolean().optional()
  })
)

export const ProjectIssues = lazyZodSchema(() =>
  z.object({
    projectId: requiredString('Project ID is required'),
    limit: OptionalFiniteNumber,
    workspaceId: ConcreteWorkspaceId,
    force: z.boolean().optional()
  })
)

export const ListCustomViews = lazyZodSchema(() =>
  z.object({
    model: z.enum(VALID_CUSTOM_VIEW_MODELS),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString,
    force: z.boolean().optional()
  })
)

export const CustomViewId = lazyZodSchema(() =>
  z.object({
    viewId: requiredString('Custom view ID is required'),
    model: z.enum(VALID_CUSTOM_VIEW_MODELS),
    workspaceId: ConcreteWorkspaceId,
    force: z.boolean().optional()
  })
)

export const CustomViewContents = lazyZodSchema(() =>
  z.object({
    viewId: requiredString('Custom view ID is required'),
    limit: OptionalFiniteNumber,
    workspaceId: ConcreteWorkspaceId,
    force: z.boolean().optional()
  })
)

export const TeamId = lazyZodSchema(() =>
  z.object({
    teamId: requiredString('Team ID is required'),
    workspaceId: OptionalString
  })
)

export const IssueUpdate = lazyZodSchema(() =>
  z.object({
    id: requiredString('Issue ID is required'),
    workspaceId: OptionalString,
    updates: z.object({
      stateId: OptionalString,
      title: OptionalString,
      description: z.string().optional(),
      assigneeId: z.union([z.string(), z.null()]).optional(),
      estimate: z.union([z.number().int().min(0), z.null()]).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      labelIds: z.array(z.string()).optional(),
      projectId: z.union([z.string(), z.null()]).optional()
    })
  })
)

export const LinearIssueCommentsParams = lazyZodSchema(() =>
  z.object({
    issueId: requiredString('Issue ID is required'),
    workspaceId: OptionalString
  })
)
