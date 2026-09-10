import { z } from 'zod'
import {
  AgentGraphAbsolutePathSchema,
  AgentGraphExecutionHostSchema,
  AgentGraphIdentifierSchema,
  AgentGraphWorkspaceIdentitySchema,
  containsAgentGraphControlCharacter
} from './workspace-scope'

export const WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT = 128
export const WORKSPACE_BOOTSTRAP_REVISION_MAX_LENGTH = 4_096

const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const WorkspaceBootstrapAuthoritySchema = z
  .object({
    kind: z.enum(['host-run', 'orca']),
    scope: z.literal('run'),
    issued_for_run_id: AgentGraphIdentifierSchema
  })
  .strict()

const WorkspaceBootstrapReceiptV2BaseSchema = z
  .object({
    schema_version: z.literal(2),
    repository_id: AgentGraphIdentifierSchema,
    canonical_root: AgentGraphAbsolutePathSchema,
    execution_host: AgentGraphExecutionHostSchema,
    orchestration_home: AgentGraphWorkspaceIdentitySchema,
    execution_workspace: AgentGraphWorkspaceIdentitySchema,
    base_revision_kind: z.enum(['git_head', 'folder_observation']),
    base_revision: z
      .string()
      .min(1)
      .max(WORKSPACE_BOOTSTRAP_REVISION_MAX_LENGTH)
      .refine(
        (value) => !containsAgentGraphControlCharacter(value),
        'Control characters are not allowed'
      ),
    dirty_state: z.enum(['clean', 'dirty', 'not_applicable']),
    dirty_path_count: z.number().int().nonnegative(),
    dirty_paths: z.array(z.string().min(1)).max(WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT),
    dirty_paths_truncated: z.boolean(),
    authority: WorkspaceBootstrapAuthoritySchema
  })
  .strict()

export const WorkspaceBootstrapReceiptV2Schema = WorkspaceBootstrapReceiptV2BaseSchema.superRefine(
  (receipt, context) => {
    validateRevision(receipt, context)
    validateDirtyPaths(receipt, context)
    validateAuthority(receipt, context)
  }
)

export type WorkspaceBootstrapReceiptV2 = z.infer<typeof WorkspaceBootstrapReceiptV2Schema>
type WorkspaceBootstrapReceiptV2Input = z.infer<typeof WorkspaceBootstrapReceiptV2BaseSchema>

function validateRevision(
  receipt: WorkspaceBootstrapReceiptV2Input,
  context: z.RefinementCtx
): void {
  const isFolder = receipt.execution_workspace.kind === 'folder'
  if (isFolder !== (receipt.base_revision_kind === 'folder_observation')) {
    addIssue(
      context,
      ['base_revision_kind'],
      'The base revision kind must match the execution workspace kind'
    )
  }

  if (receipt.base_revision_kind === 'folder_observation') {
    if (!receipt.base_revision.startsWith('folder-observation:')) {
      addIssue(
        context,
        ['base_revision'],
        'Folder observations require an opaque folder-observation revision'
      )
    }
    if (
      receipt.dirty_state !== 'not_applicable' ||
      receipt.dirty_path_count !== 0 ||
      receipt.dirty_paths.length !== 0 ||
      receipt.dirty_paths_truncated
    ) {
      addIssue(context, ['dirty_state'], 'Folder observations cannot claim Git dirty state')
    }
    return
  }

  if (!GIT_OBJECT_ID_PATTERN.test(receipt.base_revision)) {
    addIssue(
      context,
      ['base_revision'],
      'Git base revision must be a complete SHA-1 or SHA-256 object ID'
    )
  }
  if (receipt.dirty_state === 'not_applicable') {
    addIssue(context, ['dirty_state'], 'Git worktrees require clean or dirty state')
  }
  if (receipt.dirty_state === 'clean' && receipt.dirty_path_count !== 0) {
    addIssue(context, ['dirty_path_count'], 'A clean Git worktree cannot contain dirty paths')
  }
  if (receipt.dirty_state === 'dirty' && receipt.dirty_path_count === 0) {
    addIssue(context, ['dirty_path_count'], 'A dirty Git worktree requires at least one dirty path')
  }
}

function validateDirtyPaths(
  receipt: WorkspaceBootstrapReceiptV2Input,
  context: z.RefinementCtx
): void {
  const sortedPaths = [...receipt.dirty_paths].sort((left, right) => left.localeCompare(right))
  if (new Set(receipt.dirty_paths).size !== receipt.dirty_paths.length) {
    addIssue(context, ['dirty_paths'], 'Dirty paths must be unique')
  }
  for (const [index, dirtyPath] of receipt.dirty_paths.entries()) {
    if (!isCanonicalRepositoryRelativePath(dirtyPath)) {
      addIssue(
        context,
        ['dirty_paths', index],
        'Dirty paths must use canonical repository-relative paths'
      )
    }
    if (dirtyPath !== sortedPaths[index]) {
      addIssue(context, ['dirty_paths'], 'Dirty paths must be sorted deterministically')
      break
    }
  }
  if (receipt.dirty_path_count < receipt.dirty_paths.length) {
    addIssue(context, ['dirty_path_count'], 'Dirty path count cannot be smaller than its sample')
  }
  if (receipt.dirty_paths_truncated !== receipt.dirty_path_count > receipt.dirty_paths.length) {
    addIssue(
      context,
      ['dirty_paths_truncated'],
      'Dirty path truncation must describe the bounded sample'
    )
  }
}

function validateAuthority(
  receipt: WorkspaceBootstrapReceiptV2Input,
  context: z.RefinementCtx
): void {
  if (receipt.execution_workspace.execution_host_id !== receipt.execution_host.id) {
    addIssue(
      context,
      ['execution_workspace', 'execution_host_id'],
      'Execution workspace must belong to the issuing execution host'
    )
  }
  if (receipt.canonical_root !== receipt.orchestration_home.path) {
    addIssue(context, ['canonical_root'], 'Canonical root must equal the orchestration home path')
  }
  if (receipt.authority.kind !== 'host-run') {
    return
  }
  const expectedWorkspaceKey = `folder:${receipt.repository_id}`
  const matchesHostRun =
    receipt.execution_host.boundary === 'local' &&
    receipt.execution_workspace.kind === 'folder' &&
    receipt.execution_workspace.workspace_key === expectedWorkspaceKey &&
    receipt.orchestration_home.workspace_key === expectedWorkspaceKey &&
    receipt.execution_workspace.path === receipt.orchestration_home.path
  if (!matchesHostRun) {
    addIssue(
      context,
      ['authority'],
      'Host-run receipts require one matching local folder workspace'
    )
  }
}

function isCanonicalRepositoryRelativePath(value: string): boolean {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return false
  }
  if (/[?*[\]{}]/.test(value)) {
    return false
  }
  const body = value.endsWith('/') ? value.slice(0, -1) : value
  if (!body || body.includes('//')) {
    return false
  }
  return body.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message })
}
