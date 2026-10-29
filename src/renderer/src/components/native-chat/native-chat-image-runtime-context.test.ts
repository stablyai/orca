// @vitest-environment happy-dom

import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import {
  createNativeChatImageOwnerSelector,
  resolveNativeChatImageRuntimeContext,
  resolveNativeChatImageRuntimeContextForOwner,
  selectNativeChatImageOwnerState,
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import {
  agentSessionTabFixture,
  nativeChatFanoutFixture,
  nativeChatFanoutWorkspace,
  repoFixture,
  terminalTabFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'

const originalState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
})

function state(overrides: Partial<AppState> = {}): AppState {
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const worktree = worktreeFixture('wt-1', '/repo/worktree', { hostId: 'local' })
  return {
    ...useAppStore.getInitialState(),
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'wt-1',
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    getKnownWorktreeById: () => worktree,
    projectGroups: [],
    removedRuntimeEnvironmentIds: new Set(),
    repos: [repoFixture()],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [],
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    tabsByWorktree: { 'wt-1': [tab] },
    unifiedTabsByWorktree: {},
    worktreesByRepo: { repo: [worktree] },
    ...overrides
  }
}

describe('resolveNativeChatImageRuntimeContext', () => {
  it('keeps unrelated store writes out of the image-owner selector', () => {
    const storeState = state()
    const first = selectNativeChatImageOwnerState(storeState)
    const second = selectNativeChatImageOwnerState({
      ...storeState,
      agentStatusByPaneKey: {} as AppState['agentStatusByPaneKey']
    })

    expect(shallow(second, first)).toBe(true)
  })

  it("keeps tab changes in other workspaces out of a chat's owner inputs", () => {
    const storeState = state()
    const select = createNativeChatImageOwnerSelector('tab-1')
    const first = select(storeState)
    const otherWorkspaceTab = { ...storeState.tabsByWorktree['wt-1'][0], id: 'tab-2' }
    const second = select({
      ...storeState,
      tabsByWorktree: { ...storeState.tabsByWorktree, 'wt-2': [otherWorkspaceTab] },
      unifiedTabsByWorktree: { 'wt-2': [] }
    })

    expect(first.owner).toBe('wt-1')
    expect(shallow(second, first)).toBe(true)
  })

  it('reuses derived settings when owner inputs are unchanged', () => {
    const storeState = state()
    const first = resolveNativeChatImageRuntimeContext(storeState, 'tab-1')
    const second = resolveNativeChatImageRuntimeContext(storeState, 'tab-1')

    expect(first).not.toBeNull()
    expect(second?.target).toBe(first?.target)
    expect(shallow(second, first)).toBe(true)
  })

  it('derives a runtime host from an owner-only route during paired hydration', () => {
    const storeState = state()
    const ownerOnlyWorktree = {
      id: 'wt-1',
      repoId: 'repo',
      path: '/repo/worktree',
      runtimeOwnerEnvironmentId: 'owner-a'
    }
    const ownerState = {
      ...storeState,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      getKnownWorktreeById: () => ownerOnlyWorktree,
      worktreesByRepo: { repo: [ownerOnlyWorktree] },
      runtimeEnvironments: [{ id: 'owner-a' }]
    } as unknown as AppState

    const context = resolveNativeChatImageRuntimeContext(ownerState, 'tab-1')

    expect(context).toMatchObject({
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      expectedExecutionHostId: 'local',
      target: { kind: 'environment' as const, environmentId: 'owner-a' }
    })
  })

  it('reads nothing for an SSH-owned workspace with no paired server to serve it', () => {
    const worktree = worktreeFixture('wt-1', '/remote/worktree', { hostId: 'ssh:ssh-1' })
    const sshState = state({
      activeWorkspaceExecutionHostId: 'ssh:ssh-1',
      getKnownWorktreeById: () => worktree,
      repos: [repoFixture({ connectionId: 'ssh-1' })],
      worktreesByRepo: { repo: [worktree] }
    })

    expect(resolveNativeChatImageRuntimeContext(sshState, 'tab-1')).toBeNull()
  })

  it('resolves a floating chat to its pinned folder on the local host, and nothing before the pin', () => {
    const floatingTab: Tab = {
      id: 'floating-chat-1',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      groupId: 'floating-group',
      contentType: 'agent-session',
      entityId: 'session-1',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      isPinned: false,
      agentSessionAgent: 'codex'
    }
    const floatingState: AppState = {
      ...state(),
      tabsByWorktree: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      getKnownWorktreeById: () => undefined,
      worktreesByRepo: {},
      // Why a focused runtime: floating must stay local even when one is selected.
      settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-1' },
      floatingWorkspacePath: '/home/me/changed-setting'
    }

    expect(resolveNativeChatImageRuntimeContext(floatingState, 'floating-chat-1')).toBeNull()
    expect(
      resolveNativeChatImageRuntimeContext(
        {
          ...floatingState,
          structuredSessionLaunchDirectoryByTabId: {
            'floating-chat-1': { sessionId: 'session-1', launchDirectory: '/home/me/pinned' }
          }
        },
        'floating-chat-1'
      )
    ).toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      worktreePath: '/home/me/pinned',
      expectedExecutionHostId: 'local',
      target: { kind: 'local' as const }
    })
  })

  it('keeps selected-hook results equivalent to full-state resolution through ownership, pin and host transitions', () => {
    const base = state({
      worktreesByRepo: {
        repo: [
          worktreeFixture('wt-1', '/repo/worktree', { hostId: 'local' }),
          worktreeFixture('wt-2', '/repo/second', { hostId: 'local' })
        ]
      }
    })
    const duplicate = {
      ...base,
      tabsByWorktree: {
        'wt-1': [terminalTabFixture('tab-1', 'wt-1')],
        'wt-2': [terminalTabFixture('tab-1', 'wt-2')]
      },
      unifiedTabsByWorktree: {
        'wt-2': [agentSessionTabFixture('tab-1', 'wt-2')],
        'wt-1': [agentSessionTabFixture('tab-1', 'wt-1')]
      }
    }
    const fallback = { ...duplicate, tabsByWorktree: {} }
    const moved = {
      ...fallback,
      unifiedTabsByWorktree: { 'wt-1': [agentSessionTabFixture('tab-1', 'wt-1')] }
    }
    const floatingTab = agentSessionTabFixture('tab-1', FLOATING_TERMINAL_WORKTREE_ID)
    const floating = {
      ...base,
      tabsByWorktree: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      structuredSessionLaunchDirectoryByTabId: {},
      floatingWorkspacePath: '/floating-setting'
    }
    const pinned = {
      ...floating,
      structuredSessionLaunchDirectoryByTabId: {
        'tab-1': { sessionId: floatingTab.entityId, launchDirectory: '/pinned' }
      }
    }
    const replaced = {
      ...pinned,
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [{ ...floatingTab, entityId: 'replacement' }]
      }
    }
    const folder = nativeChatFanoutFixture(0, 1, 0)
    const folderState = {
      ...base,
      ...folder,
      unifiedTabsByWorktree: {
        [nativeChatFanoutWorkspace(0)]: [
          agentSessionTabFixture('tab-1', nativeChatFanoutWorkspace(0))
        ]
      }
    }
    const environment = (id: string): AppState['runtimeEnvironments'][number] => ({
      id,
      name: id,
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: null,
      runtimeId: null,
      preferredEndpointId: 'endpoint',
      endpoints: []
    })
    const remote = (id: string): AppState => ({
      ...base,
      activeWorkspaceExecutionHostId: `runtime:${id}`,
      runtimeEnvironments: [environment(id)],
      repos: [repoFixture({ executionHostId: `runtime:${id}` })],
      worktreesByRepo: {
        repo: [worktreeFixture('wt-1', '/remote', { hostId: `runtime:${id}` })]
      }
    })
    const ssh = (generation?: number): AppState => ({
      ...remote('owner-a'),
      activeWorkspaceExecutionHostId: 'ssh:ssh-1',
      worktreesByRepo: {
        repo: [
          worktreeFixture('wt-1', '/ssh', {
            hostId: 'ssh:ssh-1',
            runtimeOwnerEnvironmentId: 'owner-a'
          })
        ]
      },
      sshStateByEnvironment: new Map([
        [
          'owner-a',
          {
            targets: [],
            targetGenerations: new Map(),
            targetLabels: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true,
            connectionStates: new Map([
              [
                'ssh-1',
                {
                  targetId: 'ssh-1',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: generation
                }
              ]
            ])
          }
        ]
      ])
    })
    const local = (worktreeId: string, worktreePath: string) => ({
      worktreeId,
      worktreePath,
      target: { kind: 'local' as const }
    })
    const paired = ssh(3)
    const cases: [
      name: string,
      snapshot: AppState,
      expected: Partial<NonNullable<NativeChatImageRuntimeContext>> | null
    ][] = [
      ['terminal-first and first duplicate', duplicate, local('wt-1', '/repo/worktree')],
      ['unified fallback', fallback, local('wt-2', '/repo/second')],
      ['move', moved, local('wt-1', '/repo/worktree')],
      ['remove', { ...moved, unifiedTabsByWorktree: {} }, null],
      ['return', fallback, local('wt-2', '/repo/second')],
      ['missing pin', floating, null],
      [
        'wrong pin',
        {
          ...pinned,
          structuredSessionLaunchDirectoryByTabId: {
            'tab-1': { sessionId: 'wrong', launchDirectory: '/wrong' }
          }
        },
        null
      ],
      ['correct pin', pinned, local(FLOATING_TERMINAL_WORKTREE_ID, '/pinned')],
      ['replaced session', replaced, null],
      [
        'replaced pin',
        {
          ...replaced,
          structuredSessionLaunchDirectoryByTabId: {
            'tab-1': { sessionId: 'replacement', launchDirectory: '/replacement' }
          }
        },
        local(FLOATING_TERMINAL_WORKTREE_ID, '/replacement')
      ],
      [
        'floating directory predicate skips unregistered duplicate',
        {
          ...pinned,
          unifiedTabsByWorktree: {
            [FLOATING_TERMINAL_WORKTREE_ID]: [
              { ...floatingTab, entityId: 'unregistered', agentSessionAgent: undefined },
              floatingTab
            ]
          }
        },
        local(FLOATING_TERMINAL_WORKTREE_ID, '/pinned')
      ],
      [
        'floating terminal fallback',
        {
          ...floating,
          tabsByWorktree: {
            [FLOATING_TERMINAL_WORKTREE_ID]: [
              terminalTabFixture('tab-1', FLOATING_TERMINAL_WORKTREE_ID)
            ]
          },
          unifiedTabsByWorktree: {}
        },
        local(FLOATING_TERMINAL_WORKTREE_ID, '/floating-setting')
      ],
      [
        'floating first registered duplicate wins',
        {
          ...pinned,
          unifiedTabsByWorktree: {
            [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab, { ...floatingTab, entityId: 'second' }]
          },
          structuredSessionLaunchDirectoryByTabId: {
            'tab-1': { sessionId: 'second', launchDirectory: '/wrong-second' }
          }
        },
        null
      ],
      ['folder', folderState, local(nativeChatFanoutWorkspace(0), '/repo/0')],
      [
        'runtime',
        remote('owner-a'),
        { worktreePath: '/remote', target: { kind: 'environment', environmentId: 'owner-a' } }
      ],
      [
        'runtime replacement',
        remote('owner-b'),
        { target: { kind: 'environment', environmentId: 'owner-b' } }
      ],
      [
        'owner-only runtime hydration',
        {
          ...remote('owner-a'),
          activeWorktreeId: null,
          activeWorkspaceExecutionHostId: null,
          worktreesByRepo: {
            repo: [
              worktreeFixture('wt-1', '/remote', {
                hostId: undefined,
                runtimeOwnerEnvironmentId: 'owner-a'
              })
            ]
          }
        },
        { worktreePath: '/remote', target: { kind: 'environment', environmentId: 'owner-a' } }
      ],
      [
        'paired SSH',
        paired,
        {
          worktreePath: '/ssh',
          expectedExecutionHostId: 'ssh:ssh-1',
          expectedSshConnectionGeneration: 3,
          target: { kind: 'environment', environmentId: 'owner-a' }
        }
      ],
      [
        'SSH generation-only change',
        { ...paired, sshStateByEnvironment: ssh(4).sshStateByEnvironment },
        { expectedSshConnectionGeneration: 4 }
      ],
      [
        'SSH generation absent',
        { ...paired, sshStateByEnvironment: ssh().sshStateByEnvironment },
        null
      ],
      [
        'unpaired SSH',
        {
          ...paired,
          repos: [repoFixture({ connectionId: 'ssh-1' })],
          worktreesByRepo: {
            repo: [worktreeFixture('wt-1', '/ssh', { hostId: 'ssh:ssh-1' })]
          }
        },
        null
      ]
    ]
    let observed: NativeChatImageRuntimeContext = null
    function Probe() {
      observed = useNativeChatImageRuntimeContext('tab-1')
      return null
    }
    useAppStore.setState(base)
    render(createElement(Probe))
    for (const [name, snapshot, expected] of cases) {
      act(() => useAppStore.setState(snapshot))
      expect(observed, name).toEqual(resolveNativeChatImageRuntimeContext(snapshot, 'tab-1'))
      if (expected === null) {
        expect(observed, name).toBeNull()
      } else {
        expect(observed, name).toMatchObject(expected)
      }
    }
    expect(resolveNativeChatImageRuntimeContextForOwner(base, 'tab-1', null)).toBeNull()
  })
})
