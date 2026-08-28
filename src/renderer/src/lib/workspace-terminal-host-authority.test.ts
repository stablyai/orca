/**
 * The seeding predicate answers one question for both remote flavors: does some other party own
 * terminal creation for this workspace right now? Three answers, and only `none` seeds.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { resolveWorkspaceTerminalHostAuthority } from '@/lib/workspace-terminal-host-authority'

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

  it('distinguishes an unanswered SSH host from one that answered with nothing', () => {
    const store = createTestStore()
    seedDirectSsh(store)

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe(
      'unverifiable'
    )
    expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeNull()
    expect(terminalTabCount(store, SSH_WORKTREE_ID)).toBe(0)

    // The host answers and holds nothing here. That is positive evidence, so the workspace seeds.
    store.getState().markRemoteWorkspaceHydrated(TARGET_ID)
    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe('none')
    expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeTruthy()
    expect(terminalTabCount(store, SSH_WORKTREE_ID)).toBe(1)
  })

  it.each(['offline', 'error'] as const)(
    'falls back to none when a sync terminates in %s without ever hydrating',
    (phase) => {
      // The regression this guards: remoteWorkspaceHydratedTargetIds is add-only in practice
      // (clearRemoteWorkspaceHydrated has no production caller), so without a floor one failed sync
      // leaves every git worktree on this target terminal-less and its sleeping agents unresumable
      // for the rest of the app session — strictly worse than the pre-gate behaviour, and escapable
      // only by creating a tab by hand.
      const store = createTestStore()
      seedDirectSsh(store)
      store.getState().setRemoteWorkspaceSyncStatus(TARGET_ID, { phase, direction: 'pull' })

      expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe('none')
      expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeTruthy()
      expect(terminalTabCount(store, SSH_WORKTREE_ID)).toBe(1)
    }
  )

  it('still declines while a sync is in flight', () => {
    // The floor must not swallow the wait it exists to bound: 'pulling' is an attempt in progress,
    // not one that terminated without an answer.
    const store = createTestStore()
    seedDirectSsh(store)
    store
      .getState()
      .setRemoteWorkspaceSyncStatus(TARGET_ID, { phase: 'pulling', direction: 'pull' })

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe(
      'unverifiable'
    )
    expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeNull()
  })

  it('keeps a hydrated target on none even if a later sync errors', () => {
    // Once the host has answered, a subsequent transport error is not evidence it holds nothing new
    // — but it is also not a reason to start refusing. The hydrated branch wins.
    const store = createTestStore()
    seedDirectSsh(store)
    store.getState().markRemoteWorkspaceHydrated(TARGET_ID)
    store.getState().setRemoteWorkspaceSyncStatus(TARGET_ID, { phase: 'error', direction: 'pull' })

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe('none')
  })

  it('treats a conflicting host snapshot as unanswered', () => {
    const store = createTestStore()
    seedDirectSsh(store)
    store.getState().markRemoteWorkspaceHydrated(TARGET_ID)
    store.getState().setRemoteWorkspaceSyncStatus(TARGET_ID, { phase: 'conflict' })

    expect(resolveWorkspaceTerminalHostAuthority(store.getState(), SSH_WORKTREE_ID)).toBe(
      'unverifiable'
    )
    expect(ensureWorktreeHasInitialTerminal(store.getState(), SSH_WORKTREE_ID)).toBeNull()
    expect(terminalTabCount(store, SSH_WORKTREE_ID)).toBe(0)
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
