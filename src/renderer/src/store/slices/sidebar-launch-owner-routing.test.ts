import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import * as rendererPlatform from '@/app-shell/platform/renderer-app-platform'
import { makeDetectedResult } from './worktrees/listing/worktrees-detected-listing-fixtures'

import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { resolveAgentLaunchExecutionContext } from '@/lib/agent-session/launch/new-tab/launch-agent-execution-context'
import { describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { runtimeStatuses } from './browser/browser-slice-test-harness'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import {
  buildAgentLaunchRouteInput,
  worktreeLaunchWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'

const id = 'repo1::/path/twin'
function setup() {
  const store = createTestStore()
  seedStore(store, {
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id, repoId: 'repo1', path: '/path/twin', hostId: 'local' }),
        makeWorktree({
          id,
          repoId: 'repo1',
          path: '/path/twin',
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1'
        })
      ]
    },
    runtimeStatusByEnvironmentId: runtimeStatuses(['browser.screencast.v1'])
  })
  return store
}

describe('captured sidebar workspace copy', () => {
  it('reads agent detection and launch capabilities from the selected runtime while the local twin is active', () => {
    const state = setup().getState()
    expect(getAgentDetectionTargetKeyForWorktree(state, id, 'runtime:env-1')).toBe(
      'runtime:env-1:repo1%3A%3A%2Fpath%2Ftwin'
    )
    const input = buildAgentLaunchRouteInput(state, {
      agent: 'codex',
      workspace: worktreeLaunchWorkspace(id, 'runtime:env-1')
    })
    expect(input.executionHostId).toBe('runtime:env-1')
    expect(input.hostCapabilities).toEqual(['browser.screencast.v1'])
  })
  it('checks the selected runtime browser capability instead of the local twin on a web client', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    try {
      const state = setup().getState()
      expect(
        getWorkspaceClientCreationActionPolicy(state, id, 'runtime:env-1')['managed-browser']
      ).toEqual({ state: 'enabled', provider: 'paired-runtime' })
      expect(
        getWorkspaceClientCreationActionPolicy(state, id, 'runtime:absent')['managed-browser'].state
      ).toBe('hidden')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

it('keeps nested SSH inventory, capability transport and quoting on the owning server', () => {
  const store = setup()
  store.setState({
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id,
          repoId: 'repo1',
          path: '/path/twin',
          hostId: 'ssh:box',
          runtimeOwnerEnvironmentId: 'env-1'
        })
      ]
    },
    sshStateByEnvironment: new Map([
      [
        'env-1',
        {
          connectionStates: new Map([
            [
              'box',
              {
                targetId: 'box',
                status: 'connected',
                error: null,
                reconnectAttempt: 0,
                remotePlatform: 'linux'
              }
            ]
          ]),
          targetLabels: new Map(),
          targetGenerations: new Map(),
          removedTargetLabels: new Map(),
          targetsHydrated: true
        }
      ]
    ])
  })
  const state = store.getState()
  expect(getAgentDetectionTargetKeyForWorktree(state, id, 'ssh:box')).toBe(
    'runtime:env-1:repo1%3A%3A%2Fpath%2Ftwin'
  )
  expect(
    runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: id, hostId: 'ssh:box' })
  ).toEqual({ kind: 'resolved', environmentId: 'env-1' })
  expect(
    resolveAgentLaunchExecutionContext(state, { worktreeId: id, executionHostId: 'ssh:box' })
  ).toMatchObject({ resolvedLaunchPlatform: 'linux' })
})

it.each(['listed', 'detected', 'unstamped'] as const)(
  'keeps the selected local WSL runtime with a remote twin first (%s)',
  (publication) => {
    const store = setup()
    const local = makeWorktree({
      id,
      repoId: 'repo1',
      hostId: publication === 'unstamped' ? undefined : 'local',
      path: String.raw`\\wsl.localhost\Ubuntu\repo`
    })
    store.setState((state): Partial<ReturnType<typeof store.getState>> => ({
      repos: [
        {
          ...state.repos[0],
          id: 'repo1',
          path: 'C:\\repo',
          executionHostId: 'local',
          connectionId: null
        }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id,
            repoId: 'repo1',
            hostId: 'runtime:env-1',
            runtimeOwnerEnvironmentId: 'env-1'
          }),
          ...(publication === 'listed' ? [local] : [])
        ]
      },
      detectedWorktreesByRepo:
        publication === 'listed'
          ? {}
          : {
              repo1: {
                repoId: 'repo1',
                authoritative: true,
                source: 'git',
                worktrees: [
                  {
                    ...local,
                    ownership: 'external',
                    selectedCheckout: false,
                    visible: false
                  }
                ]
              }
            }
    }))
    const platform = vi.spyOn(rendererPlatform, 'getRendererAppPlatform').mockReturnValue('win32')
    try {
      const input = buildAgentLaunchRouteInput(store.getState(), {
        agent: 'codex',
        workspace: worktreeLaunchWorkspace(id, 'local')
      })
      expect(input.projectRuntime).toMatchObject({ runtime: { kind: 'wsl', distro: 'Ubuntu' } })
    } finally {
      platform.mockRestore()
    }
  }
)

it('compares a folder custom cwd with the selected copy root', () => {
  const store = setup()
  store.setState({
    folderWorkspaces: [
      makeFolderWorkspace({
        id: 'notes',
        folderPath: '/srv/remote',
        executionHostId: 'runtime:env-1'
      }),
      makeFolderWorkspace({ id: 'notes', folderPath: '/srv/local', executionHostId: 'local' })
    ]
  })
  const input = buildAgentLaunchRouteInput(store.getState(), {
    agent: 'codex',
    workspace: { kind: 'folder', worktreeId: 'folder:notes', hostId: 'local' },
    tuiCustomization: { cwd: '/srv/remote' }
  })
  expect(input.startsOutsideWorkspaceRoot).toBe(true)
  expect(
    buildAgentLaunchRouteInput(store.getState(), {
      agent: 'codex',
      workspace: { kind: 'folder', worktreeId: 'folder:notes', hostId: 'local' },
      tuiCustomization: { cwd: '/srv/local' }
    }).startsOutsideWorkspaceRoot
  ).toBe(false)
})

it('uses the selected detected server path when a local WSL twin is detected first', () => {
  const store = setup()
  const status = store.getState().runtimeStatusByEnvironmentId.get('env-1')!
  store.setState({
    worktreesByRepo: {},
    runtimeStatusByEnvironmentId: new Map([
      ['env-1', { ...status, status: { ...status.status!, hostPlatform: 'win32' } }]
    ]),
    detectedWorktreesByRepo: {
      repo1: makeDetectedResult('repo1', [
        makeWorktree({
          id,
          repoId: 'repo1',
          hostId: 'local',
          path: String.raw`\\wsl.localhost\Ubuntu\repo`
        }),
        makeWorktree({
          id,
          repoId: 'repo1',
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1',
          path: 'C:\\server'
        })
      ])
    }
  })
  expect(
    resolveAgentLaunchExecutionContext(store.getState(), {
      worktreeId: id,
      executionHostId: 'runtime:env-1'
    })
  ).toMatchObject({ resolvedLaunchPlatform: 'win32', isRemote: true })
})
