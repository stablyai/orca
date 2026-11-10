import { describe, expect, it, afterEach, vi } from 'vitest'

import { getRuntimeTargetForWorktreeOwner } from '@/lib/files/access/file-owner-runtime-target'

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
