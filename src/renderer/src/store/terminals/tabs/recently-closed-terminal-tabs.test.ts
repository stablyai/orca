// Reopen terminal/browser/editor snapshots in true cross-type MRU order via Cmd/Ctrl+Shift+T.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { getDefaultSettings } from '../../../../../shared/constants'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { seedThreePaneLayout } from '../../slices/tabs/three-pane-layout.test-fixture'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../../slices/worktrees/worktree.test-fixture'

import { remapClosedTerminalTabSnapshotCwds } from './recently-closed-terminal-tabs'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const WT = 'repo1::/path/wt1'

function makeSeededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WT
  })
  // Why: these tests are about where a reopened tab lands inside its group, so they start from a
  // layout the beside-a-lone-pane rule leaves alone.
  seedThreePaneLayout(store, WT)
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('terminal snapshot cwd remapping', () => {
  it('handles case-insensitive Windows roots and preserves the new separator style', () => {
    expect(
      remapClosedTerminalTabSnapshotCwds(
        [{ startupCwd: 'c:\\REPO\\old\\packages\\app' }],
        'C:\\Repo\\Old\\',
        'D:\\Worktrees\\New'
      )
    ).toEqual([{ startupCwd: 'D:\\Worktrees\\New\\packages\\app' }])
  })

  it('does not treat a POSIX backslash as a directory separator', () => {
    const snapshot = { startupCwd: '/repo/old\\sibling' }

    expect(remapClosedTerminalTabSnapshotCwds([snapshot], '/repo/old', '/repo/new')).toEqual([
      snapshot
    ])
  })
})

describe('reopenClosedTerminalTab', () => {
  it('reopens a closed terminal into its recorded group, not a second pane', async () => {
    // Why: Cmd+Shift+T returns a tab to where it was; it is replay, not a new pane.
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: WT
    })
    const first = store.getState().createTab(WT)
    const groupId = store.getState().unifiedTabsByWorktree[WT]?.[0]?.groupId
    const second = store.getState().createTab(WT, groupId, undefined, { placementFixed: true })
    store.getState().closeTab(second.id)
    await layoutApplyTestTransport.settle()
    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await layoutApplyTestTransport.settle()

    const s = store.getState()
    expect(s.groupsByWorktree[WT]).toHaveLength(1)
    expect(s.layoutByWorktree[WT]?.type).toBe('leaf')
    expect(s.tabsByWorktree[WT]?.map((tab) => tab.id)).toContain(first.id)
  })

  it('skips local reopen on a remote-runtime worktree (host owns the terminal)', async () => {
    // Runtime-owned terminal reopen must fall through to browser/editor; local create makes an unbacked phantom racing snapshots.
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1', hostId: 'runtime:env-1' })
        ]
      },
      activeWorktreeId: WT
    })
    store.setState({
      recentlyClosedTerminalTabsByWorktree: { [WT]: [{ startupCwd: '/path/wt1/api' }] },
      recentlyClosedTabKindsByWorktree: { [WT]: ['terminal'] }
    })

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(false)
    await layoutApplyTestTransport.settle()
    // No local tab spawned, and the snapshot is left intact (not consumed).
    expect(store.getState().tabsByWorktree[WT] ?? []).toHaveLength(0)
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toHaveLength(1)
  })

  it('reopens a legacy local worktree while another runtime is merely focused', async () => {
    const store = makeSeededStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' }
    })
    const tab = store.getState().createTab(WT)
    store.getState().closeTab(tab.id)
    await layoutApplyTestTransport.settle()

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await layoutApplyTestTransport.settle()
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(1)
  })
})
