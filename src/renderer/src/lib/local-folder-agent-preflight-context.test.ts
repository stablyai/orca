import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getLocalAgentPreflightContext,
  resetLocalPreflightContextCachesForTests
} from './local-preflight-context'

const FOLDER_ID = 'wsl-folder'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_ID)
const UBUNTU_FOLDER = '//wsl.localhost/Ubuntu/home/alice/projects'
const DEBIAN_FOLDER = '//wsl.localhost/Debian/home/alice/projects'
const WSL_CAPABILITIES = { wslAvailable: true, availableWslDistros: ['Ubuntu', 'Debian'] }

function repo(id: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path,
    displayName: id,
    addedAt: 1,
    badgeColor: 'blue',
    projectGroupId: 'group',
    executionHostId: 'local',
    ...overrides
  }
}

function folderState(
  options: {
    path?: string
    repos?: Repo[]
    folder?: Partial<FolderWorkspace>
    settings?: Partial<NonNullable<AppState['settings']>>
  } = {}
): AppState {
  const path = options.path ?? UBUNTU_FOLDER
  return {
    ...createTestStore().getState(),
    activeRepoId: null,
    activeWorktreeId: FOLDER_KEY,
    settings: { ...getDefaultSettings('/tmp'), ...options.settings },
    projects: [],
    repos: options.repos ?? [repo('one', `${path}/one`), repo('two', `${path}/two`)],
    worktreesByRepo: {},
    folderWorkspaces: [
      makeFolderWorkspace({
        id: FOLDER_ID,
        projectGroupId: 'group',
        folderPath: path,
        ...options.folder
      })
    ],
    projectGroups: [
      {
        id: 'group',
        name: 'Projects',
        parentPath: path,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}

describe('local folder agent preflight context', () => {
  beforeEach(resetLocalPreflightContextCachesForTests)

  it('detects the folder WSL distro when multiple repositories have no single owner', () => {
    expect(getLocalAgentPreflightContext(folderState(), 'win32', WSL_CAPABILITIES)?.wslDistro).toBe(
      'Ubuntu'
    )
  })

  it('uses the folder distro instead of the first repository distro', () => {
    const state = folderState({
      repos: [repo('one', `${DEBIAN_FOLDER}/one`), repo('two', `${UBUNTU_FOLDER}/two`)]
    })
    expect(getLocalAgentPreflightContext(state, 'win32', WSL_CAPABILITIES)?.wslDistro).toBe(
      'Ubuntu'
    )
  })

  it.each([
    UBUNTU_FOLDER,
    String.raw`\\wsl.localhost\Ubuntu\home\alice\projects`,
    '//wsl$/Ubuntu/home/alice/projects',
    String.raw`\\wsl$\Ubuntu\home\alice\projects`
  ])('detects a repo-less local folder using %s', (path) => {
    expect(
      getLocalAgentPreflightContext(folderState({ path, repos: [] }), 'win32', WSL_CAPABILITIES)
        ?.wslDistro
    ).toBe('Ubuntu')
  })

  it('preserves an explicit legacy host agent runtime', () => {
    const context = getLocalAgentPreflightContext(
      folderState({ settings: { localAgentRuntime: 'host' } }),
      'win32',
      WSL_CAPABILITIES
    )
    expect(context?.wslDistro).toBeUndefined()
    expect(context?.projectRuntime?.status).toBe('resolved')
  })

  it('preserves an explicit legacy WSL agent distro', () => {
    const context = getLocalAgentPreflightContext(
      folderState({ settings: { localAgentRuntime: 'wsl', localAgentWslDistro: 'Debian' } }),
      'win32',
      WSL_CAPABILITIES
    )
    expect(context?.wslDistro).toBe('Debian')
  })

  it('keeps Floating on the native host despite an active WSL folder', () => {
    expect(
      getLocalAgentPreflightContext(
        folderState(),
        'win32',
        WSL_CAPABILITIES,
        FLOATING_TERMINAL_WORKTREE_ID
      )
    ).toBeUndefined()
  })

  it.each(['ssh:server', 'runtime:paired'] as const)(
    'does not reinterpret a folder owned by %s as local WSL',
    (executionHostId) => {
      expect(
        getLocalAgentPreflightContext(
          folderState({ folder: { executionHostId } }),
          'win32',
          WSL_CAPABILITIES
        )?.wslDistro
      ).toBeUndefined()
    }
  )

  it('does not reinterpret ambiguous local and SSH ownership as local WSL', () => {
    const state = folderState({
      repos: [
        repo('one', `${UBUNTU_FOLDER}/one`),
        repo('two', `${UBUNTU_FOLDER}/two`, { executionHostId: 'ssh:server' })
      ]
    })
    expect(
      getLocalAgentPreflightContext(state, 'win32', WSL_CAPABILITIES)?.wslDistro
    ).toBeUndefined()
  })

  it.each(['darwin', 'linux'] as const)(
    'does not infer a local Windows runtime on %s',
    (platform) => {
      expect(
        getLocalAgentPreflightContext(folderState(), platform, WSL_CAPABILITIES)
      ).toBeUndefined()
    }
  )

  it('keeps a native Windows folder on the host', () => {
    expect(
      getLocalAgentPreflightContext(
        folderState({ path: 'C:/Users/alice/projects' }),
        'win32',
        WSL_CAPABILITIES
      )?.wslDistro
    ).toBeUndefined()
  })

  it('reports repair instead of probing another distro when the folder distro is unavailable', () => {
    const context = getLocalAgentPreflightContext(folderState(), 'win32', {
      wslAvailable: true,
      availableWslDistros: ['Debian']
    })
    expect(context?.wslDistro).toBeUndefined()
    expect(context?.projectRuntime?.status).toBe('repair-required')
  })

  it('reports repair when WSL itself is unavailable', () => {
    const context = getLocalAgentPreflightContext(folderState(), 'win32', {
      wslAvailable: false,
      availableWslDistros: []
    })
    expect(context?.wslDistro).toBeUndefined()
    expect(context?.projectRuntime?.status).toBe('repair-required')
  })

  it('uses a requested nonactive folder instead of the active folder', () => {
    const state = folderState()
    state.folderWorkspaces = [
      ...state.folderWorkspaces,
      makeFolderWorkspace({
        id: 'requested-folder',
        projectGroupId: 'requested-group',
        folderPath: DEBIAN_FOLDER,
        executionHostId: 'local'
      })
    ]
    expect(
      getLocalAgentPreflightContext(
        state,
        'win32',
        WSL_CAPABILITIES,
        folderWorkspaceKey('requested-folder')
      )?.wslDistro
    ).toBe('Debian')
  })

  it.each([true, false])(
    'keeps the selected local owner when remote-first is %s',
    (remoteFirst) => {
      const state = folderState({ folder: { executionHostId: 'local' } })
      const localFolder = state.folderWorkspaces[0]
      const remoteFolder = makeFolderWorkspace({
        id: FOLDER_ID,
        projectGroupId: 'remote-group',
        folderPath: '/remote/projects',
        executionHostId: 'runtime:paired'
      })
      state.activeWorkspaceExecutionHostId = 'local'
      state.folderWorkspaces = remoteFirst
        ? [remoteFolder, localFolder]
        : [localFolder, remoteFolder]

      expect(getLocalAgentPreflightContext(state, 'win32', WSL_CAPABILITIES)?.wslDistro).toBe(
        'Ubuntu'
      )
    }
  )

  it('returns stable snapshots without mixing distributions during folder switches', () => {
    const ubuntu = folderState()
    const debian = folderState({ path: DEBIAN_FOLDER })
    const first = getLocalAgentPreflightContext(ubuntu, 'win32', WSL_CAPABILITIES)
    const second = getLocalAgentPreflightContext(ubuntu, 'win32', WSL_CAPABILITIES)
    const other = getLocalAgentPreflightContext(debian, 'win32', WSL_CAPABILITIES)
    expect(first?.wslDistro).toBe('Ubuntu')
    expect(other?.wslDistro).toBe('Debian')
    expect(second).toBe(first)
    expect(other).not.toBe(first)
  })
})
