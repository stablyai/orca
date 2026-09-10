import { describe, expect, it } from 'vitest'
import {
  AgentGraphWorkspaceScopeSchema,
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from './workspace-scope'

const validScope = {
  schema_version: 1,
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
    workspace_key: 'worktree:repo-1',
    kind: 'git-worktree',
    path: '/repo/worktree',
    worktree_path: '/repo/worktree'
  },
  base_revision: '0123456789abcdef',
  dirty_paths: ['src/index.ts'],
  run_id: 'run-1',
  coordinator_generation: 1,
  binding_receipt_ref: 'artifact:receipts/workspace.json',
  binding_receipt_hash: `sha256:${'a'.repeat(64)}`
} as const

describe('workspace keys', () => {
  it('round-trips folder and worktree identities', () => {
    expect(parseWorkspaceKey(folderWorkspaceKey('folder-1'))).toEqual({
      type: 'folder',
      folderWorkspaceId: 'folder-1'
    })
    expect(parseWorkspaceKey(worktreeWorkspaceKey('worktree-1'))).toEqual({
      type: 'worktree',
      worktreeId: 'worktree-1'
    })
  })
})

describe('AgentGraph workspace scope', () => {
  it('accepts a strict remote or local execution workspace identity', () => {
    expect(AgentGraphWorkspaceScopeSchema.parse(validScope)).toEqual(validScope)
  })

  it('rejects cross-host execution workspace identity', () => {
    expect(
      AgentGraphWorkspaceScopeSchema.safeParse({
        ...validScope,
        execution_workspace: { ...validScope.execution_workspace, execution_host_id: 'host-other' }
      }).success
    ).toBe(false)
  })

  it('rejects schema-spread fields and worktree paths on orchestration home', () => {
    expect(
      AgentGraphWorkspaceScopeSchema.safeParse({
        ...validScope,
        orchestration_home: { ...validScope.orchestration_home, worktree_path: '/repo' }
      }).success
    ).toBe(false)
    expect(
      AgentGraphWorkspaceScopeSchema.safeParse({ ...validScope, dirty_path_count: 1 }).success
    ).toBe(false)
  })

  it('accepts Windows absolute paths without assuming POSIX execution', () => {
    const windowsScope = {
      ...validScope,
      canonical_root: 'C:\\repo',
      orchestration_home: { ...validScope.orchestration_home, path: 'C:\\repo' },
      execution_workspace: {
        ...validScope.execution_workspace,
        path: 'C:\\repo\\worktree',
        worktree_path: 'C:\\repo\\worktree'
      }
    }
    expect(AgentGraphWorkspaceScopeSchema.safeParse(windowsScope).success).toBe(true)
  })
})
