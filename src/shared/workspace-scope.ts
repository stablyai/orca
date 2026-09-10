import { z } from 'zod'
import type { WorkspaceKey, WorkspaceScope } from './folder-workspace-types'

export const AGENT_GRAPH_IDENTITY_MAX_LENGTH = 4_096

const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]).+/
const AGENT_GRAPH_IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

export function containsAgentGraphControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) {
      return true
    }
  }
  return false
}

const OpaqueAgentGraphIdentitySchema = z
  .string()
  .min(1)
  .max(AGENT_GRAPH_IDENTITY_MAX_LENGTH)
  .refine(
    (value) => !containsAgentGraphControlCharacter(value),
    'Control characters are not allowed'
  )

export const AgentGraphIdentifierSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(AGENT_GRAPH_IDENTIFIER_PATTERN)

export const AgentGraphAbsolutePathSchema = z
  .string()
  .min(1)
  .max(AGENT_GRAPH_IDENTITY_MAX_LENGTH)
  .regex(ABSOLUTE_PATH_PATTERN)
  .refine(
    (value) => !containsAgentGraphControlCharacter(value),
    'Control characters are not allowed'
  )

export const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(AGENT_GRAPH_IDENTITY_MAX_LENGTH)
  .refine(
    (value) => !containsAgentGraphControlCharacter(value),
    'Control characters are not allowed'
  )
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes('..'),
    'Path must be repository-relative'
  )

export const AgentGraphExecutionHostSchema = z
  .object({
    id: OpaqueAgentGraphIdentitySchema,
    boundary: z.enum(['local', 'remote'])
  })
  .strict()

const AgentGraphFolderWorkspaceIdentitySchema = z
  .object({
    execution_host_id: OpaqueAgentGraphIdentitySchema,
    workspace_key: OpaqueAgentGraphIdentitySchema,
    kind: z.literal('folder'),
    path: AgentGraphAbsolutePathSchema
  })
  .strict()

const AgentGraphWorktreeWorkspaceIdentitySchema = z
  .object({
    execution_host_id: OpaqueAgentGraphIdentitySchema,
    workspace_key: OpaqueAgentGraphIdentitySchema,
    kind: z.literal('git-worktree'),
    path: AgentGraphAbsolutePathSchema,
    worktree_path: AgentGraphAbsolutePathSchema
  })
  .strict()

export const AgentGraphWorkspaceIdentitySchema = z
  .discriminatedUnion('kind', [
    AgentGraphFolderWorkspaceIdentitySchema,
    AgentGraphWorktreeWorkspaceIdentitySchema
  ])
  .superRefine((workspace, context) => {
    const expectedPrefix = workspace.kind === 'folder' ? 'folder:' : 'worktree:'
    if (!workspace.workspace_key.startsWith(expectedPrefix)) {
      context.addIssue({
        code: 'custom',
        path: ['workspace_key'],
        message: `Workspace key must use the ${expectedPrefix} prefix`
      })
    }
    if (workspace.kind === 'git-worktree' && workspace.path !== workspace.worktree_path) {
      context.addIssue({
        code: 'custom',
        path: ['worktree_path'],
        message: 'Worktree path must equal the workspace path'
      })
    }
  })

export const AgentGraphWorkspaceScopeSchema = z
  .object({
    schema_version: z.literal(1),
    repository_id: AgentGraphIdentifierSchema,
    canonical_root: AgentGraphAbsolutePathSchema,
    execution_host: AgentGraphExecutionHostSchema,
    orchestration_home: AgentGraphWorkspaceIdentitySchema,
    execution_workspace: AgentGraphWorkspaceIdentitySchema,
    base_revision: z.string().min(1).max(AGENT_GRAPH_IDENTITY_MAX_LENGTH),
    dirty_paths: z.array(RepositoryRelativePathSchema).max(128),
    run_id: AgentGraphIdentifierSchema,
    coordinator_generation: z.number().int().positive(),
    binding_receipt_ref: z
      .string()
      .min(1)
      .max(AGENT_GRAPH_IDENTITY_MAX_LENGTH)
      .startsWith('artifact:'),
    binding_receipt_hash: z.string().regex(SHA256_PATTERN)
  })
  .strict()
  .superRefine((scope, context) => {
    if (new Set(scope.dirty_paths).size !== scope.dirty_paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['dirty_paths'],
        message: 'Dirty paths must be unique'
      })
    }
    if (scope.canonical_root !== scope.orchestration_home.path) {
      context.addIssue({
        code: 'custom',
        path: ['canonical_root'],
        message: 'Canonical root must equal the orchestration home path'
      })
    }
    if (scope.execution_workspace.execution_host_id !== scope.execution_host.id) {
      context.addIssue({
        code: 'custom',
        path: ['execution_workspace', 'execution_host_id'],
        message: 'Execution workspace must belong to the execution host'
      })
    }
  })

export type AgentGraphExecutionHost = z.infer<typeof AgentGraphExecutionHostSchema>
export type AgentGraphWorkspaceIdentity = z.infer<typeof AgentGraphWorkspaceIdentitySchema>
export type AgentGraphWorkspaceScope = z.infer<typeof AgentGraphWorkspaceScopeSchema>

export function parseAgentGraphWorkspaceScope(value: unknown): AgentGraphWorkspaceScope {
  return AgentGraphWorkspaceScopeSchema.parse(value)
}

export function worktreeWorkspaceKey(worktreeId: string): WorkspaceKey {
  return `worktree:${worktreeId}`
}

export function folderWorkspaceKey(folderWorkspaceId: string): WorkspaceKey {
  return `folder:${folderWorkspaceId}`
}

export function parseWorkspaceKey(value: string): WorkspaceScope | null {
  if (value.startsWith('worktree:')) {
    const worktreeId = value.slice('worktree:'.length)
    return worktreeId.length > 0 ? { type: 'worktree', worktreeId } : null
  }
  if (value.startsWith('folder:')) {
    const folderWorkspaceId = value.slice('folder:'.length)
    return folderWorkspaceId.length > 0 ? { type: 'folder', folderWorkspaceId } : null
  }
  return null
}

export function isWorkspaceKey(value: string): value is WorkspaceKey {
  return parseWorkspaceKey(value) !== null
}

// Why: folder workspaces are tracked by the scoped active key, while older
// worktree-only paths still read activeWorktreeId.
export function getActiveSidebarWorkspaceId(
  activeWorkspaceKey: string | null,
  activeWorktreeId: string | null
): string | null {
  const scope = activeWorkspaceKey ? parseWorkspaceKey(activeWorkspaceKey) : null
  if (scope?.type === 'folder') {
    return folderWorkspaceKey(scope.folderWorkspaceId)
  }
  if (scope?.type === 'worktree') {
    return scope.worktreeId
  }
  return activeWorktreeId
}
