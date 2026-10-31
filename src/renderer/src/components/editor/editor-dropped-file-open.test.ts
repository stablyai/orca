import { describe, expect, it, afterEach, vi } from 'vitest'
import { getEditorFileDropOperationContext } from './editor-dropped-file-open'

import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'

describe('shouldUploadRemoteEditorFileDrop', () => {
  it('uses the worktree owner runtime instead of the focused runtime', () => {
    expect(
      getRuntimeTargetForWorktreeOwner(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }],
          worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
        },
        'wt-1'
      )
    ).toEqual({ kind: 'environment', environmentId: 'owner-runtime' })
  })

  it('builds file operation context from the worktree owner instead of global focus', () => {
    expect(
      getEditorFileDropOperationContext(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
          worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
        },
        'wt-1',
        '/repos/repo-1',
        undefined
      )
    ).toEqual({
      target: { kind: 'local' as const },
      worktreeId: 'wt-1',
      worktreePath: '/repos/repo-1',
      connectionId: undefined
    })
  })

  it('preserves SSH ownership in editor drop operation context', () => {
    expect(
      getEditorFileDropOperationContext(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }],
          worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
        },
        'wt-1',
        '/home/orca/repo-1',
        'ssh-1'
      )
    ).toEqual({
      target: { kind: 'local' as const },
      worktreeId: 'wt-1',
      worktreePath: '/home/orca/repo-1',
      connectionId: 'ssh-1'
    })
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
