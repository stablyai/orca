import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
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
    settings: getDefaultSettings('/home/me'),
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

  it('fails closed while a runtime environment is active', () => {
    const state = makeState({
      settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-a' }
    })
    expect(isCopilotAttachOwnerLocal(state, FILE)).toBe(false)
  })

  it('rejects a tab opened through a runtime even after that runtime was switched off', () => {
    const state = makeState({ openFiles: [makeOpenFile({ runtimeEnvironmentId: 'env-a' })] })
    expect(isCopilotAttachOwnerLocal(state, FILE)).toBe(false)
  })

  it('rejects a tab whose path belongs to an SSH target', () => {
    const state = makeState({ openFiles: [makeOpenFile({ externalSshTargetId: 'box' })] })
    expect(isCopilotAttachOwnerLocal(state, FILE)).toBe(false)
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
