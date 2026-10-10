import { describe, expect, it } from 'vitest'
import {
  getEditorFileDropOperationContext,
  shouldUploadRemoteEditorFileDrop
} from './editor-dropped-file-open'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'

describe('shouldUploadRemoteEditorFileDrop', () => {
  it('does not upload editor drops for local workspaces', () => {
    expect(shouldUploadRemoteEditorFileDrop({ kind: 'local' }, null)).toBe(false)
  })

  it('uploads editor drops while a runtime environment is active', () => {
    expect(
      shouldUploadRemoteEditorFileDrop({ kind: 'environment', environmentId: 'env-1' }, null)
    ).toBe(true)
  })

  it('uploads editor drops for SSH workspaces', () => {
    expect(shouldUploadRemoteEditorFileDrop({ kind: 'local' }, 'ssh-1')).toBe(true)
  })

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

  it('keeps explicit local worktree editor drops local while a runtime is focused', () => {
    expect(
      getRuntimeTargetForWorktreeOwner(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
          worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
        },
        'wt-1'
      )
    ).toEqual({ kind: 'local' })
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
