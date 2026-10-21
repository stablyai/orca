/**
 * The seeding predicate answers one question for both remote flavors: does some other party own
 * terminal creation for this workspace right now? Three answers, and only `none` seeds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import {
  resolveWorkspaceTerminalHostAuthority,
  type WorkspaceTerminalHostAuthorityState
} from '@/lib/workspace-terminal-host-authority'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type TestStore = ReturnType<typeof createTestStore>

const LOCAL_WORKTREE_ID = 'repoLocal::/home/dev/proj/feature'
const SSH_WORKTREE_ID = 'repoSsh::/srv/proj/feature'
const PAIRED_WORKTREE_ID = 'repoPaired::/srv/proj/paired'
const TARGET_ID = 'ssh-target-1'
const ENVIRONMENT_ID = 'runtime-env-1'

function repo(id: string, path: string, connectionId?: string): never {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...(connectionId ? { connectionId } : {})
  } as never
}

function seedLocal(store: TestStore): void {
  store.setState({
    repos: [repo('repoLocal', '/home/dev/proj')],
    worktreesByRepo: {
      repoLocal: [
        makeWorktree({
          id: LOCAL_WORKTREE_ID,
          repoId: 'repoLocal',
          path: '/home/dev/proj/feature',
          hostId: 'local'
        } as never)
      ]
    }
  })
}

function seedDirectSsh(store: TestStore): void {
  store.setState({
    repos: [repo('repoSsh', '/srv/proj', TARGET_ID)],
    worktreesByRepo: {
      repoSsh: [
        makeWorktree({
          id: SSH_WORKTREE_ID,
          repoId: 'repoSsh',
          path: '/srv/proj/feature',
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    }
  })
}

function connectTarget(store: TestStore): void {
  store.getState().setSshConnectionState(TARGET_ID, {
    targetId: TARGET_ID,
    status: 'connected',
    error: null,
    reconnectAttempt: 0
  })
}

function terminalTabCount(store: TestStore, worktreeId: string): number {
  return (store.getState().tabsByWorktree[worktreeId] ?? []).length
}

describe('workspace terminal seeding authority', () => {
  it('seeds a purely local workspace immediately, exactly once', () => {
    const store = createTestStore()
    seedLocal(store)

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), LOCAL_WORKTREE_ID)).toBe('none')

    // No await, no host round trip: the client is the execution host for a local workspace.
    const tabId = ensureWorktreeHasInitialTerminal(store.getState(), LOCAL_WORKTREE_ID)
    expect(tabId).toBeTruthy()
    expect(terminalTabCount(store, LOCAL_WORKTREE_ID)).toBe(1)

    // A second activation pass must not add another.
    ensureWorktreeHasInitialTerminal(store.getState(), LOCAL_WORKTREE_ID)
    expect(terminalTabCount(store, LOCAL_WORKTREE_ID)).toBe(1)
  })

  it.each(['local', 'unstamped', 'missing', 'folder'] as const)(
    'seeds a %s workspace while an unrelated runtime is selected',
    (ownership) => {
      const store = createTestStore()
      seedLocal(store)
      if (ownership === 'unstamped') {
        store.setState({
          worktreesByRepo: {
            repoLocal: [makeWorktree({ id: LOCAL_WORKTREE_ID, repoId: 'repoLocal' })]
          }
        })
      } else if (ownership === 'missing') {
        store.setState({ repos: [], worktreesByRepo: {} })
      }
      if (ownership === 'folder') {
        store.setState({ folderWorkspaces: [makeFolderWorkspace()] })
      }
      const worktreeId = ownership === 'folder' ? 'folder:folder-1' : LOCAL_WORKTREE_ID
      const state = {
        ...store.getState(),
        settings: {
          ...store.getState().settings,
          activeRuntimeEnvironmentId: ENVIRONMENT_ID
        },
        runtimeEnvironments: [{ id: ENVIRONMENT_ID }]
      }

      expect(ensureWorktreeHasInitialTerminal(state, worktreeId)).toBeTruthy()
      expect(terminalTabCount(store, worktreeId)).toBe(1)
    }
  )

  it('seeds once the SSH target connects, with no workspace snapshot to wait for', () => {
    // The relay that served host workspace snapshots is gone (#27214), so nothing will ever answer
    // one; waiting for it left a reconnected target unable to seed or resume for good.
    const store = createTestStore()
    seedDirectSsh(store)
    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe(
      'unverifiable'
    )

    connectTarget(store)
    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe('none')
    expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeTruthy()
    expect(terminalTabCount(store, SSH_WORKTREE_ID)).toBe(1)
  })

  it('stops seeding when the SSH target drops', () => {
    const store = createTestStore()
    seedDirectSsh(store)
    connectTarget(store)
    store.getState().setSshConnectionState(TARGET_ID, {
      targetId: TARGET_ID,
      status: 'reconnecting',
      error: null,
      reconnectAttempt: 1
    })

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe(
      'unverifiable'
    )
    expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeNull()
  })

  it('leaves a worktree emptied on purpose empty at startup, even once its target connected', () => {
    const store = createTestStore()
    seedDirectSsh(store)
    connectTarget(store)
    store.setState({
      tabsByWorktree: { [SSH_WORKTREE_ID]: [] },
      closedTerminalTabTombstonesByTabId: {
        closed: { closedAt: Date.now(), worktreeId: SSH_WORKTREE_ID }
      }
    })

    // Startup restore passes no reseed option; only an explicit activation does.
    expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeNull()
    expect(terminalTabCount(store, SSH_WORKTREE_ID)).toBe(0)
    expect(
      ensureWorktreeHasInitialTerminal(
        store.getState(),
        SSH_WORKTREE_ID,
        undefined,
        undefined,
        undefined,
        undefined,
        { reseedEmptiedWorkspace: true }
      )
    ).toBeTruthy()
  })

  it('leaves terminal creation to the host of a paired runtime workspace', () => {
    const store = createTestStore()
    store.setState({
      repos: [repo('repoPaired', '/srv/proj')],
      worktreesByRepo: {
        repoPaired: [
          makeWorktree({
            id: PAIRED_WORKTREE_ID,
            repoId: 'repoPaired',
            path: '/srv/proj/paired',
            hostId: `runtime:${ENVIRONMENT_ID}`,
            runtimeOwnerEnvironmentId: ENVIRONMENT_ID
          } as never)
        ]
      }
    })

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), PAIRED_WORKTREE_ID)).toBe('live')
    expect(ensureWorktreeHasInitialTerminal(store.getState(), PAIRED_WORKTREE_ID)).toBeNull()
    expect(terminalTabCount(store, PAIRED_WORKTREE_ID)).toBe(0)
  })

  /**
   * #15556: the guard this replaces asked "am I a client of a live paired session?". Rival detected
   * publications make the owning environment unnameable, so that guard answered "no" and the client
   * seeded a local terminal beside the one the host was creating. Ownership is unresolved, not local.
   */
  it('does not seed locally when the runtime owner cannot be named', () => {
    const store = createTestStore()
    store.setState({
      repos: [repo('repoPaired', '/srv/proj')],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {
        repoPaired: {
          authoritative: true,
          worktrees: [
            makeWorktree({
              id: PAIRED_WORKTREE_ID,
              repoId: 'repoPaired',
              path: '/srv/proj/paired',
              hostId: `runtime:${ENVIRONMENT_ID}`,
              runtimeOwnerEnvironmentId: ENVIRONMENT_ID
            } as never)
          ]
        },
        repoPairedRival: {
          authoritative: true,
          worktrees: [
            makeWorktree({
              id: PAIRED_WORKTREE_ID,
              repoId: 'repoPairedRival',
              path: '/srv/proj/paired',
              hostId: 'local'
            } as never)
          ]
        }
      } as never
    })

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), PAIRED_WORKTREE_ID)).toBe(
      'unverifiable'
    )
    expect(ensureWorktreeHasInitialTerminal(store.getState(), PAIRED_WORKTREE_ID)).toBeNull()
    expect(terminalTabCount(store, PAIRED_WORKTREE_ID)).toBe(0)
  })
})

const WT = 'repo::/workspace'
const FOLDER = 'folder:folder-1'
const TARGET = 'ssh:target' as const
const base = {
  settings: { activeRuntimeEnvironmentId: 'unrelated' },
  runtimeEnvironments: [{ id: 'unrelated' }],
  runtimeEnvironmentCatalogHydrated: false
} satisfies WorkspaceTerminalHostAuthorityState
const sshRow = { id: WT, repoId: 'repo', hostId: TARGET }
const hubA = { id: 'repo', connectionId: 'target', executionHostId: 'runtime:hub-a' as const }
const hubB = { id: 'repo', connectionId: 'target', executionHostId: 'runtime:hub-b' as const }

const cases: {
  name: string
  id: string
  state: WorkspaceTerminalHostAuthorityState
  expected: 'live' | 'unverifiable' | 'none'
}[] = [
  {
    name: 'repo-owned runtime before worktree hydration',
    id: WT,
    expected: 'live',
    state: { repos: [{ id: 'repo', executionHostId: 'runtime:owner' }] }
  },
  {
    name: 'runtime HUB behind an SSH worktree',
    id: WT,
    expected: 'live',
    state: { repos: [hubA], worktreesByRepo: { repo: [sshRow] } }
  },
  {
    name: 'runtime project group owns a folder',
    id: FOLDER,
    expected: 'live',
    state: {
      folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group' }],
      projectGroups: [{ id: 'group', executionHostId: 'runtime:owner' }]
    }
  },
  {
    name: 'restored runtime folder before catalog hydration',
    id: FOLDER,
    expected: 'live',
    state: {
      folderWorkspaces: [],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: { [FOLDER]: 'runtime:restored' }
    }
  },
  {
    name: 'disconnected direct SSH folder is outside replacement scope',
    id: FOLDER,
    expected: 'none',
    state: {
      folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group', connectionId: 'target' }]
    }
  },
  {
    name: 'conflicting folder owners stay unverifiable',
    id: FOLDER,
    expected: 'unverifiable',
    state: {
      folderWorkspaces: [
        { id: 'folder-1', projectGroupId: 'group', executionHostId: 'local' },
        { id: 'folder-1', projectGroupId: 'group', executionHostId: 'runtime:owner' }
      ]
    }
  },
  {
    name: 'conflicting folder project-group owners stay unverifiable',
    id: FOLDER,
    expected: 'unverifiable',
    state: {
      folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group' }],
      projectGroups: [
        { id: 'group', executionHostId: 'local' },
        { id: 'group', executionHostId: 'runtime:owner' }
      ]
    }
  },
  {
    name: 'unroutable detected publication stays unverifiable',
    id: WT,
    expected: 'unverifiable',
    state: { detectedWorktreesByRepo: { repo: { worktrees: [{ id: WT, repoId: 'repo' }] } } }
  }
]
it.each(cases)('$name', ({ id, state, expected }) => {
  expect(resolveWorkspaceTerminalHostAuthority({ ...base, ...state }, id)).toBe(expected)
})

it('lets the explicit same-workspace host disambiguate rival catalog owners', () => {
  const state: WorkspaceTerminalHostAuthorityState = {
    ...base,
    activeWorktreeId: WT,
    repos: [
      { id: 'repo', executionHostId: 'local' },
      { id: 'repo', executionHostId: 'runtime:owner' }
    ]
  }
  expect(
    resolveWorkspaceTerminalHostAuthority({ ...state, activeWorkspaceExecutionHostId: 'local' }, WT)
  ).toBe('none')
  expect(
    resolveWorkspaceTerminalHostAuthority(
      { ...state, activeWorkspaceExecutionHostId: 'runtime:owner' },
      WT
    )
  ).toBe('live')
})

it('waits for rival SSH HUB owners, then accepts the surviving runtime owner', () => {
  const state: WorkspaceTerminalHostAuthorityState = {
    ...base,
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: TARGET,
    worktreesByRepo: { repo: [sshRow] }
  }
  expect(resolveWorkspaceTerminalHostAuthority({ ...state, repos: [hubA, hubB] }, WT)).toBe(
    'unverifiable'
  )
  expect(resolveWorkspaceTerminalHostAuthority({ ...state, repos: [hubA] }, WT)).toBe('live')
})

afterEach(() => vi.unstubAllGlobals())
it.each([WT, FOLDER])('leaves local terminal ownership with the real paired web host: %s', (id) => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  const state: WorkspaceTerminalHostAuthorityState = {
    settings: { activeRuntimeEnvironmentId: null },
    runtimeEnvironments: [{ id: 'paired-host' }],
    worktreesByRepo: { repo: [{ id: WT, repoId: 'repo', hostId: 'local' }] },
    folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group', executionHostId: 'local' }]
  }
  expect(resolveWorkspaceTerminalHostAuthority(state, id)).toBe('live')
})
