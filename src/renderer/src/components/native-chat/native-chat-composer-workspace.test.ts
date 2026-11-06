import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import {
  hasCachedWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from '@/lib/windows-terminal-capabilities'
import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  makeWorktree,
  makeFolderWorkspace,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab, makeUnifiedTab } from '@/store/slices/store-session-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createNativeChatComposerWorkspaceSelector } from './native-chat-composer-workspace'

vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))

afterEach(() => {
  resetWindowsTerminalCapabilitiesForTests()
})

describe('composer workspace context', () => {
  it('preserves a terminal chat SSH host even when a local twin is selected', () => {
    const store = createTestStore()
    store.setState({
      sshTargetLabels: new Map([['box', 'Build server']]),
      repos: [TEST_REPO, { ...TEST_REPO, executionHostId: 'ssh:box' }],
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local', branch: 'local' }),
          makeWorktree({
            id: 'wt-1',
            repoId: TEST_REPO.id,
            hostId: 'ssh:box',
            branch: 'ssh',
            path: '/srv/work'
          })
        ]
      },
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'chat', worktreeId: 'wt-1' })]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({
            id: 'chat',
            worktreeId: 'wt-1',
            groupId: 'group',
            executionHostId: 'ssh:box'
          })
        ]
      }
    })
    expect(createNativeChatComposerWorkspaceSelector('chat')(store.getState())).toMatchObject({
      branch: 'ssh',
      hostId: 'ssh:box',
      machine: 'Build server',
      kind: 'worktree',
      path: '/srv/work'
    })
  })

  it.each([
    ['git', true, 'main'],
    ['git', false, 'worktree'],
    ['folder', true, 'folder']
  ] as const)('identifies a %s checkout before Git identity arrives', (repoKind, main, kind) => {
    const store = createTestStore()
    store.setState({
      repos: [{ ...TEST_REPO, kind: repoKind }],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({
            id: 'wt',
            repoId: TEST_REPO.id,
            hostId: 'local',
            displayName: 'Sidebar name',
            isMainWorktree: main,
            branch: '',
            head: ''
          })
        ]
      }
    })
    expect(
      createNativeChatComposerWorkspaceSelector('chat', {
        worktreeId: 'wt',
        runtimeEnvironmentId: null
      })(store.getState())
    ).toMatchObject({ checkout: 'Sidebar name', kind })
  })

  it('uses this floating session pin and waits through missing or stale pins', () => {
    const store = createTestStore()
    const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
    store.setState({
      floatingWorkspacePath: '/home/me/changed-setting',
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat',
            worktreeId,
            groupId: 'group',
            entityId: 'session-1',
            contentType: 'agent-session',
            agentSessionAgent: 'codex'
          })
        ]
      },
      structuredSessionLaunchDirectoryByTabId: {}
    })
    const select = createNativeChatComposerWorkspaceSelector('chat', {
      worktreeId,
      runtimeEnvironmentId: null
    })
    expect(select(store.getState()).path).toBeUndefined()
    store.setState({
      structuredSessionLaunchDirectoryByTabId: {
        chat: { sessionId: 'old-session', launchDirectory: '/home/me/stale' }
      }
    })
    expect(select(store.getState()).path).toBeUndefined()
    store.setState({
      structuredSessionLaunchDirectoryByTabId: {
        chat: { sessionId: 'session-1', launchDirectory: '/home/me/pinned' }
      }
    })
    expect(select(store.getState())).toMatchObject({ path: '/home/me/pinned', branch: '' })
    store.setState({ floatingWorkspacePath: '/home/me/another-setting' })
    expect(select(store.getState()).path).toBe('/home/me/pinned')
    store.setState({
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat',
            worktreeId,
            groupId: 'group',
            entityId: 'session-2',
            contentType: 'agent-session',
            agentSessionAgent: 'codex'
          })
        ]
      }
    })
    expect(select(store.getState()).path).toBeUndefined()
  })

  it('uses the addressed Windows project runtime without a capability probe or active-project fallback', () => {
    const store = createTestStore()
    const local = makeWorktree({
      id: 'wt',
      repoId: TEST_REPO.id,
      projectId: 'local-project',
      hostId: 'local',
      path: 'C:\\src\\repo'
    })
    const remote = { ...local, projectId: 'remote-project', hostId: 'runtime:hub' as const }
    const project = {
      id: 'local-project',
      displayName: 'Local project',
      badgeColor: 'blue',
      sourceRepoIds: [TEST_REPO.id],
      createdAt: 0,
      updatedAt: 0
    }
    store.setState({
      settings: createGlobalSettingsFixture({
        machineName: 'Windows PC',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }),
      repos: [TEST_REPO, { ...TEST_REPO, executionHostId: 'runtime:hub' }],
      projects: [
        {
          ...project,
          id: 'remote-project',
          sourceRepoIds: [],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Wrong distro' }
        },
        { ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
      ],
      activeRepoId: TEST_REPO.id,
      activeWorktreeId: 'wt',
      activeWorkspaceExecutionHostId: 'runtime:hub',
      worktreesByRepo: { [TEST_REPO.id]: [remote, local] },
      tabsByWorktree: { wt: [makeTab({ id: 'chat', worktreeId: 'wt' })] },
      unifiedTabsByWorktree: {
        wt: [
          makeUnifiedTab({
            id: 'chat',
            worktreeId: 'wt',
            groupId: 'group',
            executionHostId: 'local'
          })
        ]
      }
    })
    const select = createNativeChatComposerWorkspaceSelector('chat')
    expect(hasCachedWindowsTerminalCapabilities()).toBe(false)
    expect(select(store.getState()).machine).toBe('Ubuntu')
    store.setState({
      projects: [{ ...project, localWindowsRuntimePreference: { kind: 'inherit-global' } }]
    })
    expect(select(store.getState()).machine).toBe('Ubuntu')
    store.setState({
      projects: [{ ...project, localWindowsRuntimePreference: { kind: 'windows-host' } }]
    })
    expect(select(store.getState()).machine).toBe('Windows PC')
    expect(
      createNativeChatComposerWorkspaceSelector('chat', {
        worktreeId: 'wt',
        runtimeEnvironmentId: null
      })(store.getState()).machine
    ).toBe('Windows PC')
    store.setState({
      projects: [{ ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }],
      worktreesByRepo: {}
    })
    expect(select(store.getState()).machine).toBe('Windows PC')
  })

  it('keeps UNC and addressed runtime WSL names', () => {
    const store = createTestStore()
    store.setState({
      repos: [TEST_REPO, { ...TEST_REPO, executionHostId: 'runtime:wsl' }],
      runtimeEnvironments: [
        {
          id: 'wsl',
          name: 'Windows host',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'direct',
          orcadDeployment: { kind: 'wsl', distro: 'Debian', localPort: 1234, remotePort: 1234 }
        }
      ],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id, hostId: 'runtime:wsl' })]
      }
    })
    expect(
      createNativeChatComposerWorkspaceSelector('chat', {
        worktreeId: 'wt',
        runtimeEnvironmentId: 'wsl'
      })(store.getState()).machine
    ).toBe('Debian')
    store.setState({
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({
            id: 'wt',
            repoId: TEST_REPO.id,
            hostId: 'local',
            path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
          })
        ]
      },
      tabsByWorktree: { wt: [makeTab({ id: 'chat', worktreeId: 'wt' })] },
      unifiedTabsByWorktree: {
        wt: [
          makeUnifiedTab({
            id: 'chat',
            worktreeId: 'wt',
            groupId: 'group',
            executionHostId: 'local'
          })
        ]
      }
    })
    expect(createNativeChatComposerWorkspaceSelector('chat')(store.getState()).machine).toBe(
      'Ubuntu'
    )
  })

  it('withholds contested owner bookkeeping instead of showing a local or routing name', () => {
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ machineName: 'My laptop' }),
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      repos: [TEST_REPO],
      worktreesByRepo: {},
      tabsByWorktree: { wt: [makeTab({ id: 'chat', worktreeId: 'wt' })] },
      detectedWorktreesByRepo: {
        [TEST_REPO.id]: makeDetectedResult(TEST_REPO.id, [
          makeWorktree({ id: 'wt', repoId: TEST_REPO.id, hostId: 'runtime:one' }),
          makeWorktree({ id: 'wt', repoId: TEST_REPO.id, hostId: 'runtime:two' })
        ])
      }
    })
    const value = createNativeChatComposerWorkspaceSelector('chat')(store.getState())
    expect(value.hostId).toBeUndefined()
    expect(value.machine).toBeUndefined()
  })

  it.each([8, 80])(
    'caches missing-folder resolution before catalog scans for %i retained consumers',
    (size) => {
      const store = createTestStore()
      let visits = 0
      const folders = Array.from({ length: size }, (_, index) => {
        const id = `existing-${index}`
        const folder = makeFolderWorkspace({ id, executionHostId: 'local' })
        Object.defineProperty(folder, 'id', {
          get: () => {
            visits++
            return id
          }
        })
        return folder
      })
      const nested = makeWorktree({
        id: 'nested',
        repoId: TEST_REPO.id,
        hostId: 'ssh:target',
        runtimeOwnerEnvironmentId: 'hub'
      })
      Object.defineProperty(nested, 'path', {
        get: () => {
          visits++
          return '/srv/nested'
        }
      })
      store.setState({
        settings: createGlobalSettingsFixture({ machineName: 'Old local name' }),
        folderWorkspaces: folders,
        repos: [{ ...TEST_REPO, executionHostId: 'ssh:target' }],
        sshTargetLabels: new Map([['target', 'Client target']]),
        runtimeEnvironments: [
          {
            id: 'hub',
            name: 'Hub',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: null,
            runtimeId: null,
            endpoints: [],
            preferredEndpointId: 'direct'
          }
        ],
        worktreesByRepo: { [TEST_REPO.id]: [nested] },
        tabsByWorktree: {
          nested: [makeTab({ id: 'nested-chat', worktreeId: 'nested' })],
          'folder:unowned': [makeTab({ id: 'unowned-chat', worktreeId: 'folder:unowned' })]
        },
        unifiedTabsByWorktree: {
          nested: [
            makeUnifiedTab({
              id: 'nested-chat',
              worktreeId: 'nested',
              groupId: 'group',
              executionHostId: 'ssh:target'
            })
          ]
        }
      })
      const selectors = Array.from({ length: size }, (_, index) =>
        createNativeChatComposerWorkspaceSelector(`chat-${index}`, {
          worktreeId: `folder:missing-${index}`,
          runtimeEnvironmentId: null
        })
      )
      selectors.push(createNativeChatComposerWorkspaceSelector('nested-chat'))
      selectors.push(createNativeChatComposerWorkspaceSelector('unowned-chat'))
      const read = () => selectors.map((select) => select(store.getState()))
      const first = read()
      expect(visits).toBeGreaterThan(0)
      visits = 0
      store.setState({
        activeWorktreeId: 'unrelated',
        activeWorkspaceExecutionHostId: 'runtime:box'
      })
      read().forEach((value, index) => expect(value).toBe(first[index]))
      expect(visits).toBe(0)
      store.setState({
        settings: createGlobalSettingsFixture({
          machineName: 'Old local name',
          activeRuntimeEnvironmentId: 'hub'
        })
      })
      read().forEach((value, index) => expect(value).toBe(first[index]))
      expect(visits).toBe(0)
      store
        .getState()
        .setEnvironmentRemovedSshTargetLabels('unrelated-server', { target: 'Old target' })
      read()
      expect(visits).toBe(0)
      for (const environmentId of ['unrelated-server', 'hub']) {
        store.getState().setEnvironmentSshConnectionState(environmentId, 'target', {
          targetId: 'target',
          status: 'connecting',
          error: null,
          reconnectAttempt: 0
        })
        read()
        store.getState().setEnvironmentSshConnectionState(environmentId, 'target', {
          targetId: 'target',
          status: 'connected',
          error: null,
          reconnectAttempt: 0
        })
        read()
      }
      expect(visits).toBe(0)
      store.setState({
        settings: createGlobalSettingsFixture({ machineName: 'New local name' }),
        runtimeEnvironments: store
          .getState()
          .runtimeEnvironments.map((entry) => ({ ...entry, name: 'Renamed hub' }))
      })
      read()
      expect(visits).toBe(0)
      expect(read()[size].machine).toBe('target')
      store.getState().setEnvironmentRemovedSshTargetLabels('hub', { target: 'Build server' })
      expect(read()[size].machine).toBe('Build server')
      store.getState().setEnvironmentRemovedSshTargetLabels('hub', { target: 'Renamed server' })
      expect(read()[size].machine).toBe('Renamed server')
      store
        .getState()
        .setEnvironmentSshTargetsMetadata('hub', [{ id: 'target', label: 'Current server' }])
      expect(read()[size].machine).toBe('Current server')
      store.getState().setEnvironmentSshTargetsMetadata('hub', [])
      expect(read()[size].machine).toBe('Renamed server')
      store.getState().removeEnvironmentSshState('hub')
      expect(read()[size].machine).toBe('target')
      expect(visits).toBe(0)
      store.setState({
        folderWorkspaces: [
          ...folders,
          makeFolderWorkspace({ id: 'missing-0', folderPath: '/arrived', executionHostId: 'local' })
        ]
      })
      expect(read()[0]).toMatchObject({ path: '/arrived' })
      expect(visits).toBeGreaterThan(0)
    }
  )
})
