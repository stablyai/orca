import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type {
  WorktreeOperationRoute,
  WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { getEditorModelOwnerKey } from './editor-model-owner'

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'file',
    filePath: '/srv/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'repo::/srv/repo',
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

function captured(route: WorktreeOperationRoute): OpenFile['operationProvenance'] {
  return {
    ownershipProjection: 'explicit',
    generation: {
      route,
      runtimeConnectionGeneration: null,
      runtimePairingRevision: undefined,
      runtimeSshGeneration: null,
      nestedSshGeneration: null,
      directSshGeneration: null
    }
  }
}

const localState: WorktreeOperationRouteState = {
  worktreesByRepo: { repo: [{ id: 'repo::/srv/repo', repoId: 'repo', hostId: 'local' }] }
}

describe('editor model ownership', () => {
  it('shares local physical files across workspace and tab identities', () => {
    expect(getEditorModelOwnerKey(file(), localState)).toBe('')
    expect(
      getEditorModelOwnerKey(
        file({
          id: 'other',
          worktreeId: 'other',
          operationProvenance: captured({ executionHostId: 'local', runtimeEnvironmentId: null })
        }),
        {}
      )
    ).toBe('')
  })

  it('keeps captured ownership when the focused host changes', () => {
    const opened = file({
      operationProvenance: captured({
        executionHostId: 'ssh:target',
        runtimeEnvironmentId: 'hub-a'
      })
    })
    const key = getEditorModelOwnerKey(opened, {})
    expect(
      getEditorModelOwnerKey(opened, {
        ...localState,
        activeWorktreeId: opened.worktreeId,
        activeWorkspaceExecutionHostId: 'runtime:hub-b'
      })
    ).toBe(key)
    expect(key).toBe('["hub-a","ssh:target"]')
  })

  it('keeps distinct paired transports to the same target separate', () => {
    const keys = ['hub-a', 'hub-b'].map((runtimeEnvironmentId) =>
      getEditorModelOwnerKey(
        file({
          operationProvenance: captured({ executionHostId: 'ssh:target', runtimeEnvironmentId })
        }),
        {}
      )
    )
    expect(keys[0]).not.toBe(keys[1])
    expect(keys).not.toContain(
      getEditorModelOwnerKey(
        file({ externalSshTargetId: 'target', runtimeEnvironmentId: null }),
        {}
      )
    )
  })

  it('uses the tab runtime hint when no owner catalog is present', () => {
    expect(getEditorModelOwnerKey(file({ runtimeEnvironmentId: 'hub-a' }), {})).toBe(
      '["hub-a","runtime:hub-a"]'
    )
    expect(getEditorModelOwnerKey(file({ runtimeEnvironmentId: 'hub-b' }), {})).toBe(
      '["hub-b","runtime:hub-b"]'
    )
  })

  it('honors an explicit local transport hint instead of the focused runtime', () => {
    const opened = file({ runtimeEnvironmentId: null, externalSshTargetId: 'target' })
    const state: WorktreeOperationRouteState = {
      worktreesByRepo: {
        repo: [
          {
            id: opened.worktreeId,
            repoId: 'repo',
            hostId: 'ssh:target',
            runtimeOwnerEnvironmentId: 'hub-a'
          }
        ]
      }
    }
    expect(getEditorModelOwnerKey(opened, state)).toBe('[null,"ssh:target"]')
  })

  it('does not adopt a new active host for a legacy local tab', () => {
    const opened = file()
    expect(
      getEditorModelOwnerKey(opened, {
        ...localState,
        activeWorktreeId: opened.worktreeId,
        activeWorkspaceExecutionHostId: 'ssh:new-target'
      })
    ).toBe('')
  })

  it('keeps unresolved owners separate from local files', () => {
    expect(getEditorModelOwnerKey(file(), {})).not.toBe('')
    expect(getEditorModelOwnerKey(file(), {})).not.toBe(
      getEditorModelOwnerKey(file({ worktreeId: 'another-owner' }), {})
    )
  })

  it('supports local and remote folder workspaces', () => {
    const opened = file({ worktreeId: folderWorkspaceKey('folder') })
    expect(
      getEditorModelOwnerKey(opened, {
        folderWorkspaces: [{ id: 'folder', projectGroupId: 'group', executionHostId: 'local' }]
      })
    ).toBe('')
    expect(
      getEditorModelOwnerKey(opened, {
        folderWorkspaces: [
          { id: 'folder', projectGroupId: 'group', executionHostId: 'runtime:hub-a' }
        ]
      })
    ).toBe('["hub-a","runtime:hub-a"]')
  })
})
