import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  resolveRepoWorktreeLaunchPlatform,
  resolveWorktreeExecutionHostPlatform
} from './execution-host-facts'
import { getDefaultSettings } from '../../../../../shared/constants'

vi.mock('../../../lib/workspace/creation/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLIENT_PLATFORM: 'win32'
}))

type State = Parameters<typeof resolveRepoWorktreeLaunchPlatform>[0]

function linuxServer(): Map<string, RuntimeEnvironmentStatus> {
  return new Map([
    [
      'linux-box',
      {
        checkedAt: 1,
        status: {
          runtimeId: 'rt',
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          hostPlatform: 'linux'
        }
      }
    ]
  ])
}

function state(): State {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    activeRepoId: null,
    activeWorktreeId: null,
    settings: getDefaultSettings('/tmp'),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: linuxServer()
  }
}

const serverRepo = { path: '/srv/repo', executionHostId: 'runtime:linux-box' }

describe('resolveRepoWorktreeLaunchPlatform from a Windows client', () => {
  it('keeps the nested SSH platform for a captured folder owner, matching ordinary launch', () => {
    const nested = state()
    nested.folderWorkspaces = [
      {
        id: 'folder',
        projectGroupId: 'group',
        name: 'Folder',
        folderPath: 'C:\\project',
        executionHostId: 'runtime:linux-box',
        connectionId: 'box',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    nested.sshStateByEnvironment.set('linux-box', {
      connectionStates: new Map([
        [
          'box',
          {
            targetId: 'box',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            remotePlatform: 'win32'
          }
        ]
      ]),
      targetLabels: new Map(),
      targetGenerations: new Map(),
      removedTargetLabels: new Map(),
      targetsHydrated: true
    })
    const ordinary = resolveWorktreeExecutionHostPlatform(nested, 'folder:folder', 'C:\\project')
    const captured = resolveWorktreeExecutionHostPlatform(
      { ...nested, activeWorktreeId: 'folder:folder' },
      'folder:folder',
      'C:\\project',
      'runtime:linux-box'
    )
    expect(ordinary).toMatchObject({ kind: 'known', platform: 'win32', hostKind: 'ssh' })
    expect(captured).toEqual(ordinary)
    nested.runtimeStatusByEnvironmentId.clear()
    expect(
      resolveWorktreeExecutionHostPlatform(
        nested,
        'folder:folder',
        'C:\\project',
        'runtime:linux-box'
      )
    ).toEqual(ordinary)
  })

  it("lets a worktree's own host outrank its repo's", () => {
    expect(
      resolveRepoWorktreeLaunchPlatform(state(), serverRepo, {
        id: 'wt',
        path: 'C:\\wt',
        hostId: 'local'
      })
    ).toBe('win32')
  })

  it("reads a server-projected SSH worktree through that server's connection", () => {
    const nested = {
      ...state(),
      sshStateByEnvironment: new Map([
        [
          'linux-box',
          {
            connectionStates: new Map([
              [
                'box',
                {
                  targetId: 'box',
                  status: 'connected' as const,
                  error: null,
                  reconnectAttempt: 0,
                  remotePlatform: 'linux' as const
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
    }
    expect(
      resolveRepoWorktreeLaunchPlatform(nested, serverRepo, {
        id: 'wt',
        path: '/home/a/wt',
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: 'linux-box'
      })
    ).toBe('linux')
  })

  it('is undefined when the server has not reported its OS', () => {
    const withheld = { ...state(), runtimeStatusByEnvironmentId: new Map() }
    expect(
      resolveRepoWorktreeLaunchPlatform(withheld, serverRepo, { id: 'wt', path: '/srv/wt' })
    ).toBeUndefined()
  })
})
