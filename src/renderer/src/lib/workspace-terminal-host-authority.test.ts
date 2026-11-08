/** Use one remote-authority question for seeding/resume: only none authorizes local terminal creation, never unverifiable. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { ensureWorktreeHasInitialTerminal } from '@/lib/workspace/activation/initial-surface/worktree-initial-terminal-seeding'
import { resolveWorkspaceTerminalHostAuthority } from '@/lib/workspace-terminal-host-authority'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type TestStore = ReturnType<typeof createTestStore>

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
  it('seeds once the SSH target connects, with no workspace snapshot to wait for', () => {
    // Host workspace snapshots no longer answer after relay removal (#27214); waiting forever strands connected targets.
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

  /** Rival detected owners make authority unresolved, not local; the old live-paired-client guard incorrectly seeded alongside host creation (#15556). */
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

afterEach(() => vi.unstubAllGlobals())
