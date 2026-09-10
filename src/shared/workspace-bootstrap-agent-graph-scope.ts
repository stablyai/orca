import { z } from 'zod'
import { AgentGraphWorkspaceScopeSchema, type AgentGraphWorkspaceScope } from './workspace-scope'
import {
  parseNegotiatedWorkspaceBootstrapReceipt,
  type NegotiatedWorkspaceBootstrapReceipt,
  type WorkspaceBootstrapWorkspaceIdentity
} from './workspace-bootstrap-receipt'

const WorkspaceScopeBindingSchema = z
  .object({
    run_id: z.string().min(1).max(512),
    coordinator_generation: z.number().int().positive(),
    binding_receipt_ref: z.string().min(1).max(4_096).startsWith('artifact:'),
    binding_receipt_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/)
  })
  .strict()

export type WorkspaceScopeBinding = z.infer<typeof WorkspaceScopeBindingSchema>

function graphWorkspaceIdentity(identity: WorkspaceBootstrapWorkspaceIdentity) {
  return {
    execution_host_id: identity.execution_host_id,
    workspace_key: identity.workspace_key,
    kind: identity.kind,
    path: identity.path,
    ...(identity.kind === 'git-worktree' ? { worktree_path: identity.worktree_path } : {})
  }
}

export function receiptToAgentGraphWorkspaceScope(
  receiptValue: NegotiatedWorkspaceBootstrapReceipt,
  bindingValue: WorkspaceScopeBinding
): AgentGraphWorkspaceScope {
  const receipt = parseNegotiatedWorkspaceBootstrapReceipt(
    receiptValue,
    receiptValue.schema_version
  )
  const binding = WorkspaceScopeBindingSchema.parse(bindingValue)
  if (receipt.authority.issued_for_run_id !== binding.run_id) {
    throw new Error('Workspace bootstrap receipt was issued for another run')
  }

  return AgentGraphWorkspaceScopeSchema.parse({
    schema_version: 1,
    repository_id: receipt.repository_id,
    canonical_root: receipt.canonical_root,
    execution_host: {
      id: receipt.execution_host.id,
      boundary: receipt.execution_host.boundary
    },
    orchestration_home: graphWorkspaceIdentity(receipt.orchestration_home),
    execution_workspace: graphWorkspaceIdentity(receipt.execution_workspace),
    base_revision: receipt.base_revision,
    dirty_paths: [...receipt.dirty_paths],
    run_id: binding.run_id,
    coordinator_generation: binding.coordinator_generation,
    binding_receipt_ref: binding.binding_receipt_ref,
    binding_receipt_hash: binding.binding_receipt_hash
  })
}
