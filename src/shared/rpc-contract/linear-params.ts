import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const VALID_CUSTOM_VIEW_MODELS = ['issue', 'project'] as const

export const LinearPriority = z.number().int().min(0).max(4).optional()

export const LinearLabelIds = z.array(requiredString('Invalid label ID')).optional()

export const Connect = z.object({
  apiKey: requiredString('Invalid API key')
})

export const WorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

export const ConcreteWorkspaceId = requiredString(
  'Concrete Linear workspace ID is required'
).refine((value) => value !== 'all', 'Concrete Linear workspace ID is required')

export const SelectWorkspace = z.object({
  workspaceId: requiredString('Workspace ID is required')
})

export const SearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString
})

export const CreateIssue = z.object({
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

export const IssueId = z.object({
  id: requiredString('Issue ID is required'),
  workspaceId: OptionalString
})

export const IssueComment = z.object({
  issueId: requiredString('Issue ID is required'),
  body: requiredString('Comment body is required'),
  workspaceId: OptionalString
})

export const ListProjects = z
  .object({
    query: OptionalString,
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString,
    force: z.boolean().optional()
  })
  .optional()

export const ProjectId = z.object({
  id: requiredString('Project ID is required'),
  workspaceId: ConcreteWorkspaceId,
  force: z.boolean().optional()
})

export const ProjectIssues = z.object({
  projectId: requiredString('Project ID is required'),
  limit: OptionalFiniteNumber,
  workspaceId: ConcreteWorkspaceId,
  force: z.boolean().optional()
})

export const ListCustomViews = z.object({
  model: z.enum(VALID_CUSTOM_VIEW_MODELS),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString,
  force: z.boolean().optional()
})

export const CustomViewId = z.object({
  viewId: requiredString('Custom view ID is required'),
  model: z.enum(VALID_CUSTOM_VIEW_MODELS),
  workspaceId: ConcreteWorkspaceId,
  force: z.boolean().optional()
})

export const CustomViewContents = z.object({
  viewId: requiredString('Custom view ID is required'),
  limit: OptionalFiniteNumber,
  workspaceId: ConcreteWorkspaceId,
  force: z.boolean().optional()
})

export const TeamId = z.object({
  teamId: requiredString('Team ID is required'),
  workspaceId: OptionalString
})

export const IssueUpdate = z.object({
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

export const LinearIssueCommentsParams = z.object({
  issueId: requiredString('Issue ID is required'),
  workspaceId: OptionalString
})
