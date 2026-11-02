import { z } from 'zod'
import {
  OptionalFiniteNumber,
  OptionalString,
  requiredString
} from './rpc-param-primitives'

export const PlanePriority = z.enum(['none', 'urgent', 'high', 'medium', 'low'])

export const ConnectSchema = z.object({
  apiKey: requiredString('API token is required'),
  baseUrl: OptionalString,
  authType: z.enum(['cloud', 'self-hosted']).optional()
})

export const SelectWorkspaceSchema = z.object({
  slug: requiredString('Workspace slug is required')
})

export const WorkspaceSelection = z
  .object({
    workspaceSlug: OptionalString
  })
  .optional()

export const ListStatesSchema = z.object({
  projectId: requiredString('Project ID is required'),
  workspaceSlug: OptionalString
})

export const ListIssuesSchema = z
  .object({
    workspaceSlug: OptionalString,
    projectId: OptionalString,
    limit: OptionalFiniteNumber
  })
  .optional()

export const GetIssueSchema = z.object({
  id: requiredString('Issue ID is required'),
  workspaceSlug: OptionalString,
  projectId: OptionalString,
  includeComments: z.boolean().optional()
})

export const CreateIssueSchema = z.object({
  title: requiredString('Title is required'),
  projectId: requiredString('Project is required'),
  description: OptionalString,
  stateId: OptionalString,
  priority: PlanePriority.optional(),
  workspaceSlug: OptionalString
})

export const SetStateSchema = z.object({
  id: requiredString('Issue ID is required'),
  to: requiredString('State is required'),
  workspaceSlug: OptionalString,
  projectId: OptionalString
})

export const SetPrioritySchema = z.object({
  id: requiredString('Issue ID is required'),
  priority: PlanePriority,
  workspaceSlug: OptionalString,
  projectId: OptionalString
})

export const AddCommentSchema = z.object({
  id: requiredString('Issue ID is required'),
  body: requiredString('Comment body is required'),
  workspaceSlug: OptionalString,
  projectId: OptionalString
})
