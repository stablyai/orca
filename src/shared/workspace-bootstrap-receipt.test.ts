import { describe, expect, it } from 'vitest'
import {
  createWorkspaceBootstrapReceipt,
  isWorkspaceBootstrapReceipt,
  parseNegotiatedWorkspaceBootstrapReceipt,
  parseWorkspaceBootstrapReceipt,
  WorkspaceBootstrapReceiptV2Schema,
  WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT,
  workspaceIdentity
} from './workspace-bootstrap-receipt'

describe('workspace bootstrap receipt', () => {
  it('keeps separate home and execution identities with opaque keys', () => {
    const receipt = createWorkspaceBootstrapReceipt({
      repository_id: 'repo-1',
      canonical_root: '/srv/orchestration',
      execution_host: { id: 'ssh:box%3A22', boundary: 'remote' },
      orchestration_home: workspaceIdentity({
        executionHostId: 'runtime:local',
        workspaceKey: 'runtime:home-id',
        kind: 'folder',
        path: '/srv/orchestration'
      }),
      execution_workspace: workspaceIdentity({
        executionHostId: 'ssh:box%3A22',
        workspaceKey: 'ssh:workspace%3Aopaque',
        kind: 'git-worktree',
        path: '/srv/work',
        worktreePath: '/srv/work'
      }),
      base_revision: 'abc123',
      dirty_paths: ['src/file.ts'],
      issued_for_run_id: 'run-1'
    })
    expect(Object.keys(receipt)).toEqual([
      'schema_version',
      'repository_id',
      'canonical_root',
      'execution_host',
      'orchestration_home',
      'execution_workspace',
      'base_revision',
      'dirty_paths',
      'authority'
    ])
    expect(parseWorkspaceBootstrapReceipt(receipt)).toEqual(receipt)
    expect(isWorkspaceBootstrapReceipt(receipt)).toBe(true)
    expect(isWorkspaceBootstrapReceipt({ ...receipt, canonical_root: '/srv/other' })).toBe(false)
    expect(
      isWorkspaceBootstrapReceipt({
        ...receipt,
        execution_workspace: { ...receipt.execution_workspace, execution_host_id: 'runtime:other' }
      })
    ).toBe(false)
    expect(isWorkspaceBootstrapReceipt({ ...receipt, dirty_paths: ['/src/file.ts'] })).toBe(false)
    expect(
      isWorkspaceBootstrapReceipt({
        ...receipt,
        execution_workspace: { ...receipt.execution_workspace, worktree_path: '/srv/other' }
      })
    ).toBe(false)
  })

  it('rejects extra receipt fields and folder worktree paths', () => {
    expect(
      isWorkspaceBootstrapReceipt({
        schema_version: 1,
        repository_id: 'repo',
        canonical_root: '/repo',
        execution_host: { id: 'runtime:local', boundary: 'local' },
        orchestration_home: {
          execution_host_id: 'local',
          workspace_key: 'folder:f',
          kind: 'folder',
          path: '/repo',
          worktree_path: '/repo'
        },
        execution_workspace: {
          execution_host_id: 'local',
          workspace_key: 'folder:f',
          kind: 'folder',
          path: '/repo'
        },
        base_revision: 'head',
        dirty_paths: [],
        authority: { kind: 'orca', scope: 'run', issued_for_run_id: 'run' },
        extra: true
      })
    ).toBe(false)
  })

  it('rejects duplicate dirty paths and preserves opaque identifiers', () => {
    const receipt = {
      schema_version: 1,
      repository_id: 'repo-1',
      canonical_root: 'C:\\orca',
      execution_host: { id: 'ssh:host%3A22', boundary: 'remote' },
      orchestration_home: {
        execution_host_id: 'runtime:win32',
        workspace_key: 'runtime:home',
        kind: 'folder',
        path: 'C:\\orca'
      },
      execution_workspace: {
        execution_host_id: 'ssh:host%3A22',
        workspace_key: 'ssh:workspace',
        kind: 'folder',
        path: 'D:\\work'
      },
      base_revision: 'head',
      dirty_paths: ['src/file.ts', 'src/file.ts'],
      authority: { kind: 'orca', scope: 'run', issued_for_run_id: 'run-1' }
    }
    expect(isWorkspaceBootstrapReceipt(receipt)).toBe(false)
    expect(
      parseWorkspaceBootstrapReceipt({ ...receipt, dirty_paths: ['src/file.ts'] })
    ).toMatchObject({
      execution_host: { id: 'ssh:host%3A22' },
      orchestration_home: { execution_host_id: 'runtime:win32' },
      execution_workspace: { execution_host_id: 'ssh:host%3A22', workspace_key: 'ssh:workspace' }
    })
  })

  it('accepts the host-run authority shape with its required bindings', () => {
    const runId = 'host-run-12345678-1234-4123-8123-123456789abc'
    const receipt = createWorkspaceBootstrapReceipt({
      repository_id: runId,
      canonical_root: '/srv/orchestration',
      execution_host: { id: 'runtime:local', boundary: 'local' },
      orchestration_home: workspaceIdentity({
        executionHostId: 'runtime:local',
        workspaceKey: `folder:${runId}`,
        kind: 'folder',
        path: '/srv/orchestration'
      }),
      execution_workspace: workspaceIdentity({
        executionHostId: 'runtime:local',
        workspaceKey: `folder:${runId}`,
        kind: 'folder',
        path: '/srv/orchestration'
      }),
      base_revision: 'head',
      dirty_paths: [],
      issued_for_run_id: runId,
      authorityKind: 'host-run'
    })
    expect(receipt.authority.kind).toBe('host-run')
    expect(
      isWorkspaceBootstrapReceipt({
        ...receipt,
        execution_workspace: { ...receipt.execution_workspace, path: '/srv/other' }
      })
    ).toBe(false)
    expect(
      isWorkspaceBootstrapReceipt({
        ...receipt,
        orchestration_home: { ...receipt.orchestration_home, workspace_key: 'folder:another-run' }
      })
    ).toBe(false)
  })
})

const receiptV2Base = {
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
  authority: { kind: 'orca', scope: 'run', issued_for_run_id: 'run-1' }
} as const

const gitReceiptV2 = {
  ...receiptV2Base,
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
  dirty_path_count: 2,
  dirty_paths: ['src/a.ts', 'src/b.ts'],
  dirty_paths_truncated: false
} as const

describe('workspace bootstrap receipt v2', () => {
  it('preserves negotiated v1 receipt meaning', () => {
    const receiptV1 = {
      ...receiptV2Base,
      schema_version: 1,
      execution_workspace: gitReceiptV2.execution_workspace,
      base_revision: '0123456789abcdef0123456789abcdef01234567',
      dirty_paths: ['src/index.ts']
    }
    expect(parseNegotiatedWorkspaceBootstrapReceipt(receiptV1, 1)).toEqual(receiptV1)
  })

  it('accepts deterministic bounded Git dirty evidence', () => {
    expect(WorkspaceBootstrapReceiptV2Schema.parse(gitReceiptV2)).toEqual(gitReceiptV2)
  })

  it('accepts folder observation without invented Git state', () => {
    const folderReceipt = {
      ...receiptV2Base,
      execution_workspace: receiptV2Base.orchestration_home,
      base_revision_kind: 'folder_observation',
      base_revision: 'folder-observation:opaque-1',
      dirty_state: 'not_applicable',
      dirty_path_count: 0,
      dirty_paths: [],
      dirty_paths_truncated: false
    }
    expect(WorkspaceBootstrapReceiptV2Schema.safeParse(folderReceipt).success).toBe(true)
  })

  it('rejects unsorted, absolute, parent-traversing, and noncanonical dirty paths', () => {
    for (const dirtyPaths of [
      ['src/b.ts', 'src/a.ts'],
      ['/repo/secret.ts'],
      ['src/../secret.ts'],
      ['src\\secret.ts']
    ]) {
      expect(
        WorkspaceBootstrapReceiptV2Schema.safeParse({
          ...gitReceiptV2,
          dirty_path_count: dirtyPaths.length,
          dirty_paths: dirtyPaths
        }).success
      ).toBe(false)
    }
  })

  it('rejects samples beyond the contract limit and contradictory truncation', () => {
    const dirtyPaths = Array.from(
      { length: WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT + 1 },
      (_, index) => `src/${String(index).padStart(3, '0')}.ts`
    )
    expect(
      WorkspaceBootstrapReceiptV2Schema.safeParse({
        ...gitReceiptV2,
        dirty_path_count: dirtyPaths.length,
        dirty_paths: dirtyPaths
      }).success
    ).toBe(false)
    expect(
      WorkspaceBootstrapReceiptV2Schema.safeParse({
        ...gitReceiptV2,
        dirty_path_count: 3,
        dirty_paths_truncated: false
      }).success
    ).toBe(false)
  })

  it('rejects a folder receipt downgraded through the negotiated v1 parser', () => {
    const folderReceipt = {
      ...receiptV2Base,
      execution_workspace: receiptV2Base.orchestration_home,
      base_revision_kind: 'folder_observation',
      base_revision: 'folder-observation:opaque-1',
      dirty_state: 'not_applicable',
      dirty_path_count: 0,
      dirty_paths: [],
      dirty_paths_truncated: false
    }
    expect(() => parseNegotiatedWorkspaceBootstrapReceipt(folderReceipt, 1)).toThrow()
  })

  it('rejects execution workspace identity from another host', () => {
    expect(
      WorkspaceBootstrapReceiptV2Schema.safeParse({
        ...gitReceiptV2,
        execution_workspace: { ...gitReceiptV2.execution_workspace, execution_host_id: 'other' }
      }).success
    ).toBe(false)
  })
})
