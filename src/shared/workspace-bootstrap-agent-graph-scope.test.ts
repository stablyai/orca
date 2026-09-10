import { describe, expect, it } from 'vitest'
import { AgentGraphWorkspaceScopeSchema } from './workspace-scope'
import { receiptToAgentGraphWorkspaceScope } from './workspace-bootstrap-agent-graph-scope'
import type { WorkspaceBootstrapReceiptV2 } from './workspace-bootstrap-receipt'

const binding = {
  run_id: 'run-1',
  coordinator_generation: 2,
  binding_receipt_ref: 'artifact:receipts/workspace.json',
  binding_receipt_hash: `sha256:${'b'.repeat(64)}`
} as const

const folderReceipt: WorkspaceBootstrapReceiptV2 = {
  schema_version: 2,
  repository_id: 'repo-1',
  canonical_root: '/repo',
  execution_host: { id: 'host-local', boundary: 'local' },
  orchestration_home: {
    execution_host_id: 'host-local',
    workspace_key: 'folder:repo-1',
    kind: 'folder',
    path: '/repo'
  },
  execution_workspace: {
    execution_host_id: 'host-local',
    workspace_key: 'folder:repo-1',
    kind: 'folder',
    path: '/repo'
  },
  base_revision_kind: 'folder_observation',
  base_revision: 'folder-observation:opaque-1',
  dirty_state: 'not_applicable',
  dirty_path_count: 0,
  dirty_paths: [],
  dirty_paths_truncated: false,
  authority: { kind: 'orca', scope: 'run', issued_for_run_id: 'run-1' }
}

describe('workspace bootstrap AgentGraph conversion', () => {
  it('converts a folder receipt through the strict AgentGraph schema', () => {
    const scope = receiptToAgentGraphWorkspaceScope(folderReceipt, binding)
    expect(AgentGraphWorkspaceScopeSchema.parse(scope)).toEqual(scope)
    expect(scope.execution_workspace.kind).toBe('folder')
  })

  it('selects only legal fields and keeps worktree path on execution workspace', () => {
    const receipt: WorkspaceBootstrapReceiptV2 = {
      ...folderReceipt,
      execution_workspace: {
        execution_host_id: 'host-local',
        workspace_key: 'worktree:repo-1',
        kind: 'git-worktree',
        path: '/repo/worktree',
        worktree_path: '/repo/worktree'
      },
      base_revision_kind: 'git_head',
      base_revision: '0123456789abcdef0123456789abcdef01234567',
      dirty_state: 'dirty',
      dirty_path_count: 1,
      dirty_paths: ['src/index.ts']
    }
    const scope = receiptToAgentGraphWorkspaceScope(receipt, binding)
    expect(scope.orchestration_home).not.toHaveProperty('worktree_path')
    expect(scope.execution_workspace).toHaveProperty('worktree_path', '/repo/worktree')
    expect(scope).not.toHaveProperty('dirty_path_count')
    expect(scope).not.toHaveProperty('dirty_paths_truncated')
  })

  it('rejects cross-run receipt reuse', () => {
    expect(() =>
      receiptToAgentGraphWorkspaceScope(folderReceipt, { ...binding, run_id: 'run-other' })
    ).toThrow('another run')
  })
})
