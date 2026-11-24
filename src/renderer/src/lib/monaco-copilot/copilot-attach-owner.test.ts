import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { isCopilotAttachOwnerLocal } from './copilot-attach-owner'

type State = Parameters<typeof isCopilotAttachOwnerLocal>[0]

const FILE = { fileId: '/srv/repo/a.ts', filePath: '/srv/repo/a.ts', worktreeId: 'r::/srv/repo' }

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: FILE.fileId,
    filePath: FILE.filePath,
    relativePath: 'a.ts',
    worktreeId: FILE.worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function makeState(overrides: Partial<State> = {}): State {
  const repo: Repo = {
    id: 'r',
    path: '/srv/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }
  return {
    openFiles: [makeOpenFile()],
    folderWorkspaces: [],
    projectGroups: [],
    repos: [repo],
    worktreesByRepo: {},
    ...overrides
  }
}

describe('isCopilotAttachOwnerLocal', () => {
  it('accepts a local file with no runtime or SSH owner', () => {
    expect(isCopilotAttachOwnerLocal(makeState(), FILE)).toBe(true)
  })

  it('rejects a tab opened through a runtime even after that runtime was switched off', () => {
    const state = makeState({ openFiles: [makeOpenFile({ runtimeEnvironmentId: 'env-a' })] })
    expect(isCopilotAttachOwnerLocal(state, FILE)).toBe(false)
  })

  it('rejects a tab whose path belongs to an SSH target', () => {
    const state = makeState({ openFiles: [makeOpenFile({ externalSshTargetId: 'box' })] })
    expect(isCopilotAttachOwnerLocal(state, FILE)).toBe(false)
  })

  it('rejects a missing tab or a tab captured on a paired host with a local path', () => {
    expect(isCopilotAttachOwnerLocal(makeState({ openFiles: [] }), FILE)).toBe(false)
    const openFile = makeOpenFile({
      operationProvenance: {
        ownershipProjection: 'explicit',
        generation: {
          route: { executionHostId: 'local', runtimeEnvironmentId: null },
          authority: { endpoint: { kind: 'environment', environmentId: 'env-a' }, at: 'local' },
          runtimeConnectionGeneration: null,
          runtimePairingRevision: undefined,
          runtimeSshGeneration: null,
          nestedSshGeneration: null,
          directSshGeneration: null
        }
      }
    })
    expect(isCopilotAttachOwnerLocal(makeState({ openFiles: [openFile] }), FILE)).toBe(false)
  })

  it('rejects a workspace whose host is not provably local', () => {
    const state = makeState({
      repos: [
        {
          id: 'r',
          path: '/srv/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ]
    })
    expect(isCopilotAttachOwnerLocal(state, FILE)).toBe(false)
  })
})
