import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const LINEAR_DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const LinearDueDate = z.string().refine((value) => LINEAR_DUE_DATE_PATTERN.test(value), {
  message: 'Linear due dates must use YYYY-MM-DD'
})

export const OptionalLinearDueDate = LinearDueDate.optional()

export const OptionalLinearDueDateOrClear = z.union([LinearDueDate, z.null()]).optional()

export const AgentSearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

export const LinearWorkspaceRead = z.object({
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

export const LinearTeamLookup = z.object({
  teamInput: requiredString('Missing team'),
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is only valid for team list'
  })
})

export const LinearIssueList = z.object({
  filter: z.enum(['assigned', 'created', 'all', 'completed', 'open']).optional(),
  teamInput: OptionalString,
  limit: OptionalFiniteNumber,
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

export const LinearProjectList = z.object({
  query: OptionalString,
  limit: OptionalFiniteNumber,
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

export const LinearIncludeFlags = z.object({
  comments: z.boolean(),
  children: z.boolean(),
  attachments: z.boolean(),
  relations: z.boolean(),
  activity: z.boolean().default(false)
})

export const LinearCurrentContext = z
  .object({
    worktreeId: OptionalString,
    terminalHandle: OptionalString,
    cwd: OptionalString,
    remote: z.boolean().optional()
  })
  .optional()

export const LinearWriteTarget = z.object({
  input: OptionalString,
  current: z.boolean().optional(),
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is not valid for Linear writes'
  }),
  context: LinearCurrentContext
})

export const AgentIssueContext = z.object({
  input: OptionalString,
  current: z.boolean().optional(),
  workspaceId: OptionalString,
  include: LinearIncludeFlags,
  depth: z.number().int().min(0).max(5),
  context: LinearCurrentContext
})

export const LinearIssueSetState = LinearWriteTarget.extend({
  to: requiredString('Missing target state')
})

export const LinearIssueUpdateTask = LinearWriteTarget.extend({
  operation: z.enum(['assignee', 'priority', 'estimate', 'dueDate', 'labels']),
  assigneeId: z.string().nullable().optional(),
  assigneeMe: z.boolean().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  estimate: z.number().int().min(0).nullable().optional(),
  dueDate: OptionalLinearDueDateOrClear,
  labelMode: z.enum(['add', 'remove', 'set']).optional(),
  labels: z.array(z.string()).optional()
})

export const LinearIssueAddComment = LinearWriteTarget.extend({
  body: requiredString('Missing comment body'),
  replyTo: OptionalString,
  writeId: OptionalString
})

export const LinearIssueRelationWrite = LinearWriteTarget.extend({
  relatedInput: requiredString('Missing related issue'),
  relationship: z.enum(['blocks', 'blockedBy', 'relatedTo', 'duplicateOf']),
  operation: z.enum(['add', 'remove'])
})

export const LinearIssueAttachLink = LinearWriteTarget.extend({
  url: requiredString('Missing attachment URL'),
  title: OptionalString,
  writeId: OptionalString
})

export const LinearIssueCreate = z.object({
  title: requiredString('Missing issue title'),
  body: OptionalString,
  teamInput: OptionalString,
  teamKey: OptionalString,
  state: OptionalString,
  assignee: OptionalString,
  priority: z.number().int().min(0).max(4).optional(),
  estimate: z.number().int().min(0).optional(),
  dueDate: OptionalLinearDueDate,
  labels: z.array(z.string()).optional(),
  projectInput: OptionalString,
  parentInput: OptionalString,
  parentCurrent: z.boolean().optional(),
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is not valid for Linear writes'
  }),
  writeId: OptionalString,
  context: LinearCurrentContext
})

export const LinearSaveIssue = LinearWriteTarget.extend({
  team: OptionalString,
  title: OptionalString,
  description: z.string().optional(),
  state: OptionalString,
  assignee: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  estimate: z.number().min(0).nullable().optional(),
  dueDate: OptionalLinearDueDateOrClear,
  labels: z.array(z.string()).optional(),
  project: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  writeId: OptionalString
})
