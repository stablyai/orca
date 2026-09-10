import { z } from 'zod'
import {
  WorkspaceBootstrapReceiptV2Schema,
  type WorkspaceBootstrapReceiptV2
} from './workspace-bootstrap-receipt-v2'

export {
  WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT,
  WORKSPACE_BOOTSTRAP_REVISION_MAX_LENGTH,
  WorkspaceBootstrapReceiptV2Schema
} from './workspace-bootstrap-receipt-v2'

export const WORKSPACE_BOOTSTRAP_RECEIPT_SCHEMA_VERSION = 1 as const

const opaqueIdentifierSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\p{Cc}]+$/u)
const identifierSchema = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
const absolutePathSchema = z.string().regex(/^(?:\/|[A-Za-z]:[\\/]).+/)

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
  const parts = body.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function workspaceIdentitiesEqual(
  left: WorkspaceBootstrapWorkspaceIdentity,
  right: WorkspaceBootstrapWorkspaceIdentity
): boolean {
  return (
    left.execution_host_id === right.execution_host_id &&
    left.workspace_key === right.workspace_key &&
    left.kind === right.kind &&
    left.path === right.path &&
    left.worktree_path === right.worktree_path
  )
}

const executionHostSchema = z
  .object({ id: opaqueIdentifierSchema, boundary: z.enum(['local', 'remote']) })
  .strict()

const workspaceIdentitySchema = z
  .object({
    execution_host_id: opaqueIdentifierSchema,
    workspace_key: opaqueIdentifierSchema,
    kind: z.enum(['folder', 'git-worktree']),
    path: absolutePathSchema,
    worktree_path: absolutePathSchema.optional()
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.kind === 'git-worktree' && !identity.worktree_path) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Git worktrees require worktree_path'
      })
    }
    if (
      identity.kind === 'git-worktree' &&
      identity.worktree_path &&
      identity.worktree_path !== identity.path
    ) {
      context.addIssue({
        path: ['worktree_path'],
        code: z.ZodIssueCode.custom,
        message: 'Git worktree worktree_path must equal path'
      })
    }
    if (identity.kind === 'folder' && identity.worktree_path) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Folders cannot carry worktree_path'
      })
    }
  })

const authoritySchema = z
  .object({
    kind: z.enum(['host-run', 'orca']),
    scope: z.literal('run'),
    issued_for_run_id: identifierSchema
  })
  .strict()

export const WorkspaceBootstrapReceiptSchema = z
  .object({
    schema_version: z.literal(WORKSPACE_BOOTSTRAP_RECEIPT_SCHEMA_VERSION),
    repository_id: identifierSchema,
    canonical_root: absolutePathSchema,
    execution_host: executionHostSchema,
    orchestration_home: workspaceIdentitySchema,
    execution_workspace: workspaceIdentitySchema,
    base_revision: z.string().min(1),
    dirty_paths: z
      .array(z.string().min(1))
      .refine((paths) => new Set(paths).size === paths.length, 'dirty_paths must be unique'),
    authority: authoritySchema
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.canonical_root !== receipt.orchestration_home.path) {
      context.addIssue({
        path: ['canonical_root'],
        code: z.ZodIssueCode.custom,
        message: 'canonical_root must equal orchestration_home.path'
      })
    }
    if (receipt.execution_workspace.execution_host_id !== receipt.execution_host.id) {
      context.addIssue({
        path: ['execution_workspace', 'execution_host_id'],
        code: z.ZodIssueCode.custom,
        message: 'execution_workspace must belong to execution_host'
      })
    }
    for (const [index, dirtyPath] of receipt.dirty_paths.entries()) {
      if (!isCanonicalRepositoryRelativePath(dirtyPath)) {
        context.addIssue({
          path: ['dirty_paths', index],
          code: z.ZodIssueCode.custom,
          message: 'dirty_paths must use canonical repository-relative paths'
        })
      }
    }
    if (receipt.authority.kind !== 'host-run') {
      return
    }

    const hostRunRepositoryPattern =
      /^host-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    const hostRunWorkspacePattern = new RegExp(`^folder:${receipt.repository_id}$`)
    if (!hostRunRepositoryPattern.test(receipt.repository_id)) {
      context.addIssue({
        path: ['repository_id'],
        code: z.ZodIssueCode.custom,
        message: 'Invalid host-run repository id'
      })
    }
    if (receipt.execution_host.boundary !== 'local') {
      context.addIssue({
        path: ['execution_host', 'boundary'],
        code: z.ZodIssueCode.custom,
        message: 'Host-run receipts require a local execution host'
      })
    }
    if (!workspaceIdentitiesEqual(receipt.orchestration_home, receipt.execution_workspace)) {
      context.addIssue({
        path: ['execution_workspace'],
        code: z.ZodIssueCode.custom,
        message: 'Host-run receipts require matching workspace identities'
      })
    }
    if (receipt.orchestration_home.kind !== 'folder') {
      context.addIssue({
        path: ['orchestration_home', 'kind'],
        code: z.ZodIssueCode.custom,
        message: 'Host-run receipts require a folder workspace'
      })
    }
    if (receipt.orchestration_home.path !== receipt.canonical_root) {
      context.addIssue({
        path: ['orchestration_home', 'path'],
        code: z.ZodIssueCode.custom,
        message: 'Host-run workspace path must equal canonical_root'
      })
    }
    for (const [field, identity] of [
      ['orchestration_home', receipt.orchestration_home],
      ['execution_workspace', receipt.execution_workspace]
    ] as const) {
      if (identity.kind !== 'folder' || !hostRunWorkspacePattern.test(identity.workspace_key)) {
        context.addIssue({
          path: [field],
          code: z.ZodIssueCode.custom,
          message: 'Host-run receipts require the host-run folder workspace key'
        })
      }
    }
  })

export const WorkspaceBootstrapReceiptV1Schema = WorkspaceBootstrapReceiptSchema

export type WorkspaceBootstrapWorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>
export type WorkspaceBootstrapReceipt = z.infer<typeof WorkspaceBootstrapReceiptSchema>
export type WorkspaceBootstrapReceiptV1 = WorkspaceBootstrapReceipt
export type NegotiatedWorkspaceBootstrapReceipt =
  | WorkspaceBootstrapReceiptV1
  | WorkspaceBootstrapReceiptV2
export type { WorkspaceBootstrapReceiptV2 }
export type WorkspaceBootstrapReceiptInput = Omit<
  WorkspaceBootstrapReceipt,
  'schema_version' | 'authority'
> & { issued_for_run_id: string; authorityKind?: WorkspaceBootstrapReceipt['authority']['kind'] }

export function createWorkspaceBootstrapReceipt(
  input: WorkspaceBootstrapReceiptInput
): WorkspaceBootstrapReceipt {
  return WorkspaceBootstrapReceiptSchema.parse({
    schema_version: WORKSPACE_BOOTSTRAP_RECEIPT_SCHEMA_VERSION,
    repository_id: input.repository_id,
    canonical_root: input.canonical_root,
    execution_host: input.execution_host,
    orchestration_home: input.orchestration_home,
    execution_workspace: input.execution_workspace,
    base_revision: input.base_revision,
    dirty_paths: [...input.dirty_paths],
    authority: {
      kind: input.authorityKind ?? 'orca',
      scope: 'run',
      issued_for_run_id: input.issued_for_run_id
    }
  })
}

export function parseWorkspaceBootstrapReceipt(value: unknown): WorkspaceBootstrapReceipt {
  return WorkspaceBootstrapReceiptSchema.parse(value)
}

export function parseNegotiatedWorkspaceBootstrapReceipt(
  value: unknown,
  negotiatedVersion: 1 | 2
): NegotiatedWorkspaceBootstrapReceipt {
  return negotiatedVersion === 1
    ? WorkspaceBootstrapReceiptSchema.parse(value)
    : WorkspaceBootstrapReceiptV2Schema.parse(value)
}

export function isWorkspaceBootstrapReceipt(value: unknown): value is WorkspaceBootstrapReceipt {
  return WorkspaceBootstrapReceiptSchema.safeParse(value).success
}

export function workspaceIdentity(args: {
  executionHostId: string
  workspaceKey: string
  kind: WorkspaceBootstrapWorkspaceIdentity['kind']
  path: string
  worktreePath?: string
}): WorkspaceBootstrapWorkspaceIdentity {
  return workspaceIdentitySchema.parse({
    execution_host_id: args.executionHostId,
    workspace_key: args.workspaceKey,
    kind: args.kind,
    path: args.path,
    ...(args.worktreePath ? { worktree_path: args.worktreePath } : {})
  })
}
