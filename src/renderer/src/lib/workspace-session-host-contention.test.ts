/**
 * A worktree id is `repoId::path` with no host component, so one repo registered on two hosts
 * publishes the same id for two different workspaces (STA-4343). Persistence used to fold every
 * such id into the 'local' partition, which gave both workspaces ONE `tabsByWorktree` bucket:
 * whichever host wrote last erased the other's tabs permanently.
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  indexWorktreeHostClaims,
  mergeWorkspaceSessionsWithHostShadow,
  pickPrimaryHostForClaims
} from './workspace-session-host-contention'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import {
  buildHostIdByWorktreeId,
  patchWorkspaceSessionByHost,
  persistWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

const SHARED_ID = 'repo-shared::/work/orca'
const SSH_HOST: ExecutionHostId = 'ssh:build-box'

function tab(id: string, worktreeId = SHARED_ID): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sessionWithTabs(entries: Record<string, TerminalTab[]>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree: entries }
}

function contestedState(overrides: Partial<HostPersistenceState> = {}): HostPersistenceState {
  return {
    repos: [
      { id: 'repo-shared', connectionId: null, executionHostId: 'local' },
      {
        id: 'repo-shared',
        connectionId: 'build-box',
        executionHostId: SSH_HOST
      }
    ],
    worktreesByRepo: {
      'repo-shared': [
        { id: SHARED_ID, repoId: 'repo-shared', hostId: 'local' },
        { id: SHARED_ID, repoId: 'repo-shared', hostId: SSH_HOST }
      ]
    },
    ...overrides
  }
}

describe('indexWorktreeHostClaims', () => {
  it('records every host publishing the same workspace id', () => {
    const claims = indexWorktreeHostClaims(contestedState().worktreesByRepo, new Map())

    expect([...(claims.get(SHARED_ID) ?? [])].sort()).toEqual(['local', SSH_HOST])
  })

  it('attributes an unqualified row through its repo when the repo names one host', () => {
    const claims = indexWorktreeHostClaims(
      { 'repo-a': [{ id: 'repo-a::/work/a', repoId: 'repo-a' }] },
      new Map([['repo-a', SSH_HOST]])
    )

    expect([...(claims.get('repo-a::/work/a') ?? [])]).toEqual([SSH_HOST])
  })

  it('leaves an unqualified row unattributed when its repo id is itself ambiguous', () => {
    const claims = indexWorktreeHostClaims(
      { 'repo-a': [{ id: 'repo-a::/work/a', repoId: 'repo-a' }] },
      new Map([['repo-a', null]])
    )

    expect(claims.has('repo-a::/work/a')).toBe(false)
  })

  it('prefers local as primary, else the lowest host id', () => {
    expect(pickPrimaryHostForClaims([SSH_HOST, 'local'])).toBe('local')
    expect(pickPrimaryHostForClaims(['runtime:b', 'runtime:a'])).toBe('runtime:a')
  })
})

describe('buildHostIdByWorktreeId for a contested workspace id', () => {
  it('routes a local/SSH collision to one deterministic primary', () => {
    expect(buildHostIdByWorktreeId(contestedState())(SHARED_ID)).toBe('local')
  })

  it('gives two runtime claimants a runtime primary instead of folding them into local', () => {
    const owner = buildHostIdByWorktreeId({
      repos: [],
      worktreesByRepo: {
        'repo-shared': [
          { id: SHARED_ID, repoId: 'repo-shared', hostId: 'runtime:env-b' },
          { id: SHARED_ID, repoId: 'repo-shared', hostId: 'runtime:env-a' }
        ]
      }
    })

    expect(owner(SHARED_ID)).toBe('runtime:env-a')
  })
})

describe('mergeWorkspaceSessionsWithHostShadow', () => {
  it('parks a co-claimant partition entry instead of letting it win the shared key', () => {
    const merged = mergeWorkspaceSessionsWithHostShadow({
      local: sessionWithTabs({ [SHARED_ID]: [tab('local-tab')] }),
      [SSH_HOST]: sessionWithTabs({ [SHARED_ID]: [tab('ssh-tab')] })
    })

    expect(merged.session.tabsByWorktree[SHARED_ID]?.map((entry) => entry.id)).toEqual([
      'local-tab'
    ])
    expect(
      (merged.shadow[SSH_HOST]?.tabsByWorktree?.[SHARED_ID] ?? []).map((entry) => entry.id)
    ).toEqual(['ssh-tab'])
    expect(merged.shadow.local).toBeUndefined()
  })

  it('leaves uncontested partitions untouched', () => {
    const merged = mergeWorkspaceSessionsWithHostShadow({
      local: sessionWithTabs({ 'repo-a::/a': [tab('a', 'repo-a::/a')] }),
      'runtime:env-1': sessionWithTabs({
        'repo-b::/b': [tab('b', 'repo-b::/b')]
      })
    })

    expect(Object.keys(merged.session.tabsByWorktree).sort()).toEqual(['repo-a::/a', 'repo-b::/b'])
    expect(merged.shadow).toEqual({})
  })
})

type SessionWriteMock = Mock<
  (session: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
>
type SessionPatchMock = Mock<
  (patch: Partial<WorkspaceSessionState>, hostId?: ExecutionHostId) => Promise<void>
>

describe('writing a contested workspace id back', () => {
  const RUNTIME_HOST: ExecutionHostId = 'runtime:env-1'
  const RUNTIME_ONLY_ID = 'repo-runtime::/srv/app'
  const shadow = {
    [RUNTIME_HOST]: sessionWithTabs({ [SHARED_ID]: [tab('runtime-tab')] })
  }

  /** The runtime host owns a second workspace, so its partition is rewritten by every persist —
   *  the write that used to take the contested row down with it. */
  function runtimeCoClaimantState(
    overrides: Partial<HostPersistenceState> = {}
  ): HostPersistenceState {
    return {
      repos: [],
      worktreesByRepo: {
        'repo-shared': [
          { id: SHARED_ID, repoId: 'repo-shared', hostId: 'local' },
          { id: SHARED_ID, repoId: 'repo-shared', hostId: RUNTIME_HOST }
        ],
        'repo-runtime': [{ id: RUNTIME_ONLY_ID, repoId: 'repo-runtime', hostId: RUNTIME_HOST }]
      },
      contestedHostWorkspaceSessions: shadow,
      ...overrides
    }
  }

  function livePayload(): WorkspaceSessionState {
    return sessionWithTabs({
      [SHARED_ID]: [tab('local-tab')],
      [RUNTIME_ONLY_ID]: [tab('runtime-only-tab', RUNTIME_ONLY_ID)]
    })
  }

  async function persist(state: HostPersistenceState): Promise<SessionWriteMock> {
    const set: SessionWriteMock = vi.fn(async () => {})
    await persistWorkspaceSessionByHost(
      {
        set,
        get: vi.fn(),
        patch: vi.fn(),
        setSync: vi.fn(),
        flush: vi.fn(async () => {})
      },
      livePayload(),
      state
    )
    return set
  }

  function tabIds(session: Partial<WorkspaceSessionState> | undefined, key: string): string[] {
    return (session?.tabsByWorktree?.[key] ?? []).map((entry) => entry.id)
  }

  it('keeps the co-claimant rows in its own partition when that partition is rewritten', async () => {
    const set = await persist(runtimeCoClaimantState())

    const runtimeWrite = set.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(tabIds(runtimeWrite, SHARED_ID)).toEqual(['runtime-tab'])
    expect(tabIds(runtimeWrite, RUNTIME_ONLY_ID)).toEqual(['runtime-only-tab'])
    const localWrite = set.mock.calls.find(([, hostId]) => hostId === undefined)?.[0]
    expect(tabIds(localWrite, SHARED_ID)).toEqual(['local-tab'])
  })

  it('carries a parked field the slice never seeded through a full partition replace', async () => {
    // Why: api.set swaps the whole partition, so a field with no live entry routing to the
    // co-claimant would otherwise be written without its parked rows and erased on disk.
    const set: SessionWriteMock = vi.fn(async () => {})
    await persistWorkspaceSessionByHost(
      {
        set,
        get: vi.fn(),
        patch: vi.fn(),
        setSync: vi.fn(),
        flush: vi.fn(async () => {})
      },
      {
        ...sessionWithTabs({ [SHARED_ID]: [tab('local-tab')] }),
        // Seeds the runtime slice (so its partition IS rewritten) without seeding tabsByWorktree.
        lastVisitedAtByWorktreeId: { [RUNTIME_ONLY_ID]: 1 }
      },
      runtimeCoClaimantState()
    )

    const runtimeWrite = set.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(runtimeWrite).toBeDefined()
    expect(tabIds(runtimeWrite, SHARED_ID)).toEqual(['runtime-tab'])
  })

  it('restores the parked rows on the debounced patch path too', () => {
    const patch: SessionPatchMock = vi.fn(async () => {})
    patchWorkspaceSessionByHost(
      { patch, get: vi.fn(), setSync: vi.fn() },
      { tabsByWorktree: livePayload().tabsByWorktree },
      runtimeCoClaimantState()
    )

    const runtimePatch = patch.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(tabIds(runtimePatch, SHARED_ID)).toEqual(['runtime-tab'])
  })

  it('omits a field the patch never touched so the partition keeps its own copy', () => {
    const patch: SessionPatchMock = vi.fn(async () => {})
    patchWorkspaceSessionByHost(
      { patch, get: vi.fn(), setSync: vi.fn() },
      { activeTabId: 'tab-1' },
      runtimeCoClaimantState()
    )

    const runtimePatch = patch.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(runtimePatch?.tabsByWorktree).toBeUndefined()
  })

  it('drops a parked row once the catalog says that host no longer publishes the id', async () => {
    const set = await persist(
      runtimeCoClaimantState({
        worktreesByRepo: {
          'repo-shared': [{ id: SHARED_ID, repoId: 'repo-shared', hostId: 'local' }],
          'repo-runtime': [
            {
              id: RUNTIME_ONLY_ID,
              repoId: 'repo-runtime',
              hostId: RUNTIME_HOST
            }
          ]
        }
      })
    )

    const runtimeWrite = set.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(runtimeWrite?.tabsByWorktree[SHARED_ID]).toBeUndefined()
  })

  it('keeps a parked row whose workspace the catalog cannot speak for yet', async () => {
    const folderKey = folderWorkspaceKey('folder-1')
    const set = await persist(
      runtimeCoClaimantState({
        contestedHostWorkspaceSessions: {
          [RUNTIME_HOST]: sessionWithTabs({
            [folderKey]: [tab('folder-tab', folderKey)]
          })
        }
      })
    )

    const runtimeWrite = set.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(tabIds(runtimeWrite, folderKey)).toEqual(['folder-tab'])
  })

  it('leaves an untouched partition alone rather than rewriting it from the shadow', async () => {
    const set = await persist(contestedState({ contestedHostWorkspaceSessions: shadow }))

    expect(set.mock.calls.some(([, hostId]) => hostId === RUNTIME_HOST)).toBe(false)
  })
})

/**
 * The read decides which partition a row came from; the write must not re-decide it. When the two
 * disagreed, a write copied one host's workspace into another host's partition — worse than the
 * shared bucket this PR set out to fix.
 */
describe('read-time primary is the one the write path honours', () => {
  const RUNTIME_HOST: ExecutionHostId = 'runtime:env-1'
  const RUNTIME_ONLY_ID = 'repo-runtime::/srv/app'

  function sshVersusRuntimeState(
    overrides: Partial<HostPersistenceState> = {}
  ): HostPersistenceState {
    return {
      repos: [],
      worktreesByRepo: {
        'repo-shared': [
          { id: SHARED_ID, repoId: 'repo-shared', hostId: SSH_HOST },
          { id: SHARED_ID, repoId: 'repo-shared', hostId: RUNTIME_HOST }
        ],
        'repo-runtime': [{ id: RUNTIME_ONLY_ID, repoId: 'repo-runtime', hostId: RUNTIME_HOST }]
      },
      ...overrides
    }
  }

  it('keeps an SSH claimant in the local partition it actually persists in', () => {
    // Why this shape: the claims catalog sorts `runtime:` before `ssh:`, so picking a primary from
    // claimants sent the SSH workspace's rows into the runtime partition.
    expect(buildHostIdByWorktreeId(sshVersusRuntimeState())(SHARED_ID)).toBe('local')
  })

  it('does not strand the runtime co-claimant when the SSH row is written', async () => {
    const set: SessionWriteMock = vi.fn(async () => {})
    await persistWorkspaceSessionByHost(
      { set, get: vi.fn(), patch: vi.fn(), setSync: vi.fn(), flush: vi.fn(async () => {}) },
      sessionWithTabs({
        [SHARED_ID]: [tab('ssh-tab')],
        [RUNTIME_ONLY_ID]: [tab('runtime-only-tab', RUNTIME_ONLY_ID)]
      }),
      sshVersusRuntimeState({
        contestedHostWorkspaceSessions: {
          [RUNTIME_HOST]: sessionWithTabs({ [SHARED_ID]: [tab('runtime-tab')] })
        }
      })
    )

    const runtimeWrite = set.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(runtimeWrite?.tabsByWorktree[SHARED_ID]?.map((entry) => entry.id)).toEqual([
      'runtime-tab'
    ])
    const localWrite = set.mock.calls.find(([, hostId]) => hostId === undefined)?.[0]
    expect(localWrite?.tabsByWorktree[SHARED_ID]?.map((entry) => entry.id)).toEqual(['ssh-tab'])
  })

  it('writes a row back to the only partition that had it instead of copying it', async () => {
    const set: SessionWriteMock = vi.fn(async () => {})
    await persistWorkspaceSessionByHost(
      { set, get: vi.fn(), patch: vi.fn(), setSync: vi.fn(), flush: vi.fn(async () => {}) },
      sessionWithTabs({ [SHARED_ID]: [tab('runtime-tab')] }),
      {
        repos: [],
        worktreesByRepo: {
          'repo-shared': [
            { id: SHARED_ID, repoId: 'repo-shared', hostId: 'local' },
            { id: SHARED_ID, repoId: 'repo-shared', hostId: RUNTIME_HOST }
          ]
        },
        contestedPrimaryHostBySessionKey: { [SHARED_ID]: RUNTIME_HOST }
      }
    )

    const runtimeWrite = set.mock.calls.find(([, hostId]) => hostId === RUNTIME_HOST)?.[0]
    expect(runtimeWrite?.tabsByWorktree[SHARED_ID]?.map((entry) => entry.id)).toEqual([
      'runtime-tab'
    ])
    const localWrite = set.mock.calls.find(([, hostId]) => hostId === undefined)?.[0]
    expect(localWrite?.tabsByWorktree[SHARED_ID]).toBeUndefined()
  })

  it('still migrates a workspace the catalog has re-attributed to another partition', () => {
    const owner = buildHostIdByWorktreeId({
      repos: [],
      worktreesByRepo: {
        'repo-shared': [{ id: SHARED_ID, repoId: 'repo-shared', hostId: RUNTIME_HOST }]
      },
      contestedPrimaryHostBySessionKey: { [SHARED_ID]: 'local' }
    })

    expect(owner(SHARED_ID)).toBe(RUNTIME_HOST)
  })

  it('records the partition every restored key came from, contested or not', () => {
    const merged = mergeWorkspaceSessionsWithHostShadow({
      local: sessionWithTabs({ [SHARED_ID]: [tab('local-tab')] }),
      [RUNTIME_HOST]: sessionWithTabs({
        [SHARED_ID]: [tab('runtime-tab')],
        [RUNTIME_ONLY_ID]: [tab('runtime-only-tab', RUNTIME_ONLY_ID)]
      })
    })

    expect(merged.primaryHostBySessionKey).toEqual({
      [SHARED_ID]: 'local',
      [RUNTIME_ONLY_ID]: RUNTIME_HOST
    })
  })

  it('does not name a runtime owner for a key the local partition kept', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      {
        get: vi.fn(async (hostId?: ExecutionHostId) =>
          hostId === RUNTIME_HOST
            ? sessionWithTabs({ [SHARED_ID]: [tab('runtime-tab')] })
            : sessionWithTabs({ [SHARED_ID]: [tab('local-tab')] })
        )
      },
      [],
      [RUNTIME_HOST]
    )

    // Why it matters: a runtime owner here makes startup build runtime placeholders for the local
    // workspace whose row the merge actually kept.
    expect(read.runtimeHostIdByWorkspaceSessionKey[SHARED_ID]).toBeUndefined()
    expect(read.contestedPrimaryHostBySessionKey[SHARED_ID]).toBe('local')
  })
})
