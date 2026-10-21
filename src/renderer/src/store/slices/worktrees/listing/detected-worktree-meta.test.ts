import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { applyDetectedWorktreeUpdates, folderWorkspaceMatchesHost } from './detected-worktree-meta'

describe('folderWorkspaceMatchesHost', () => {
  it('prefers the host stamp, then the connection id, then local', () => {
    type Row = Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>
    const ssh: Row = { executionHostId: 'ssh:target-1', connectionId: null }
    expect(folderWorkspaceMatchesHost(ssh, 'ssh:target-1')).toBe(true)
    expect(folderWorkspaceMatchesHost(ssh, 'local')).toBe(false)
    const stamped: Row = { executionHostId: 'runtime:env-1', connectionId: 'target-1' }
    expect(folderWorkspaceMatchesHost(stamped, 'runtime:env-1')).toBe(true)
    expect(folderWorkspaceMatchesHost(stamped, 'ssh:target-1')).toBe(false)
    const legacy: Row = { executionHostId: undefined, connectionId: 'target-1' }
    expect(folderWorkspaceMatchesHost(legacy, 'ssh:target-1')).toBe(true)
    expect(folderWorkspaceMatchesHost({ connectionId: '  ' }, 'local')).toBe(true)
    expect(folderWorkspaceMatchesHost({ connectionId: null }, 'local')).toBe(true)
  })
})

describe('applyDetectedWorktreeUpdates display-name provenance', () => {
  it('projects pinning changes into detected rows', () => {
    const detected = {
      id: 'repo-1::/workspace/feature',
      displayName: 'feature',
      displayNameMode: 'automatic',
      repoId: 'repo-1',
      branch: 'refs/heads/feature'
    }
    const state = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [detected]
      }
    } as unknown as Record<string, DetectedWorktreeListResult>

    const fixed = applyDetectedWorktreeUpdates(state, detected.id, {
      displayName: 'Agent workspace',
      displayNameIsPinned: true
    })
    expect(fixed['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'Agent workspace',
      displayNameMode: 'fixed'
    })

    const automatic = applyDetectedWorktreeUpdates(state, detected.id, {
      displayName: '',
      displayNameIsPinned: false
    })
    expect(automatic['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'feature',
      displayNameMode: 'automatic'
    })
  })

  it('keeps text until the host resolves a detached fallback', () => {
    const detached = {
      id: 'repo-1::/workspace/feature',
      displayName: 'Agent workspace',
      displayNameMode: 'fixed' as const,
      repoId: 'repo-1',
      branch: ''
    }
    const detachedState = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [detached]
      }
    } as unknown as Record<string, DetectedWorktreeListResult>

    const automatic = applyDetectedWorktreeUpdates(detachedState, detached.id, {
      displayName: '',
      displayNameIsPinned: false
    })

    expect(automatic['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'Agent workspace',
      displayNameMode: 'automatic'
    })
  })
})
