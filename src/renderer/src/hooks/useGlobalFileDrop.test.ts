import { describe, expect, it } from 'vitest'
import {
  getEditorFileDropOperationContext,
  getEditorFileDropSettingsForWorktree,
  getNativeFileDropRejectionMessage,
  shouldUploadRemoteEditorFileDrop
} from './useGlobalFileDrop'

describe('shouldUploadRemoteEditorFileDrop', () => {
  it('does not upload editor drops for local workspaces', () => {
    expect(shouldUploadRemoteEditorFileDrop({ activeRuntimeEnvironmentId: null }, null)).toBe(false)
  })

  it('uploads editor drops while a runtime environment is active', () => {
    expect(shouldUploadRemoteEditorFileDrop({ activeRuntimeEnvironmentId: 'env-1' }, null)).toBe(
      true
    )
  })

  it('uploads editor drops for SSH workspaces', () => {
    expect(shouldUploadRemoteEditorFileDrop({ activeRuntimeEnvironmentId: null }, 'ssh-1')).toBe(
      true
    )
  })

  it('uses the worktree owner runtime instead of the focused runtime', () => {
    expect(
      getEditorFileDropSettingsForWorktree(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }],
          worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
        },
        'wt-1'
      )
    ).toEqual({ activeRuntimeEnvironmentId: 'owner-runtime' })
  })

  it('keeps explicit local worktree editor drops local while a runtime is focused', () => {
    expect(
      getEditorFileDropSettingsForWorktree(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
          worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
        },
        'wt-1'
      )
    ).toEqual({ activeRuntimeEnvironmentId: null })
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
      settings: { activeRuntimeEnvironmentId: null },
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
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath: '/home/orca/repo-1',
      connectionId: 'ssh-1'
    })
  })

  it('formats metadata-only rejection messages for oversized native drops', () => {
    expect(
      getNativeFileDropRejectionMessage({
        byteLength: 0,
        pathCount: 999,
        reason: 'too-many-paths',
        target: 'rejected'
      })
    ).toEqual({
      description: 'Drop 256 or fewer files at a time.',
      title: 'Drop contains too many files.'
    })

    const message = getNativeFileDropRejectionMessage({
      byteLength: 300_000,
      pathCount: 2,
      reason: 'paths-too-large',
      target: 'rejected'
    })
    expect(message).toEqual({
      description: 'Drop fewer files or use a shorter path list.',
      title: 'Drop path list is too large.'
    })
    expect(JSON.stringify(message)).not.toContain('secret')
  })
})
