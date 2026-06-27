import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  getAiVaultResumeRepoTargetStatus,
  getAiVaultResumeWorktreeTargetStatus,
  getAiVaultResumeWorkspaceTargetStatus,
  isLocalAiVaultResumeRepo,
  isNonLocalAiVaultResumeRepo
} from './ai-vault-resume-target'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

type ResumeTargetState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

function makeState(
  overrides: Partial<Record<keyof ResumeTargetState, unknown>>
): ResumeTargetState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    worktreesByRepo: {},
    ...overrides
  } as unknown as ResumeTargetState
}

describe('ai vault resume target ownership', () => {
  it('classifies local, SSH, runtime, and unknown repo owners', () => {
    expect(getAiVaultResumeRepoTargetStatus({ connectionId: null, executionHostId: 'local' })).toBe(
      'local'
    )
    expect(getAiVaultResumeRepoTargetStatus({ connectionId: 'ssh-1', executionHostId: null })).toBe(
      'non-local'
    )
    expect(
      getAiVaultResumeRepoTargetStatus({
        connectionId: null,
        executionHostId: 'runtime:env-1'
      })
    ).toBe('non-local')
    expect(getAiVaultResumeRepoTargetStatus(null)).toBe('unknown')
  })

  it('exposes boolean predicates for resume gates', () => {
    expect(isLocalAiVaultResumeRepo({ connectionId: null, executionHostId: 'local' })).toBe(true)
    expect(
      isNonLocalAiVaultResumeRepo({ connectionId: null, executionHostId: 'runtime:env-1' })
    ).toBe(true)
  })

  it('resolves runtime-owned worktree targets through their repo owner', () => {
    expect(
      getAiVaultResumeWorktreeTargetStatus({
        worktreeId: 'repo-1::/repo/orca',
        worktrees: [{ id: 'repo-1::/repo/orca', repoId: 'repo-1' }],
        repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }]
      })
    ).toBe('non-local')
  })

  it('uses the composite worktree repo id when worktree discovery is incomplete', () => {
    expect(
      getAiVaultResumeWorkspaceTargetStatus(
        makeState({
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }]
        }),
        'repo-1::/repo/orca'
      )
    ).toBe('non-local')
  })

  it('resolves explicit workspace keys through the target worktree owner', () => {
    expect(
      getAiVaultResumeWorkspaceTargetStatus(
        makeState({
          worktreesByRepo: {
            'repo-1': [{ id: 'repo-1::/repo/orca', repoId: 'repo-1' }]
          },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }]
        }),
        'worktree:repo-1::/repo/orca'
      )
    ).toBe('non-local')
  })

  it('blocks folder workspaces owned by runtime project groups', () => {
    expect(
      getAiVaultResumeWorkspaceTargetStatus(
        makeState({
          folderWorkspaces: [
            {
              id: 'folder-1',
              projectGroupId: 'group-1',
              name: 'Platform',
              folderPath: '/repo/platform'
            }
          ],
          projectGroups: [{ id: 'group-1', executionHostId: 'runtime:env-1' }]
        }),
        folderWorkspaceKey('folder-1')
      )
    ).toBe('non-local')
  })

  it('blocks mixed local and runtime folder workspace targets', () => {
    expect(
      getAiVaultResumeWorkspaceTargetStatus(
        makeState({
          folderWorkspaces: [
            {
              id: 'folder-1',
              projectGroupId: 'group-1',
              name: 'Platform',
              folderPath: '/repo/platform'
            }
          ],
          projectGroups: [{ id: 'group-1' }],
          repos: [
            { id: 'repo-local', path: '/repo/platform/web', connectionId: null },
            {
              id: 'repo-runtime',
              path: '/repo/platform/api',
              connectionId: null,
              executionHostId: 'runtime:env-1'
            }
          ]
        }),
        folderWorkspaceKey('folder-1')
      )
    ).toBe('non-local')
  })
})
