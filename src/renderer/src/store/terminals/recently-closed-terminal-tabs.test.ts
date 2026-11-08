// Reopen terminal/browser/editor snapshots in true cross-type MRU order via Cmd/Ctrl+Shift+T.
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
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

import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'

import { remapClosedTerminalTabSnapshotCwds } from './recently-closed-terminal-tabs'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'

import { loadMainLayoutModel } from '@/runtime/workspace-layout/testing/main-loaded-layout-frames.test-fixture'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout/frames/workspace-layout-frame-sync'
import { endLayoutFramePositions } from '@/runtime/workspace-layout/frames/layout-frame-position'
import { buildWorkspaceSessionPayload } from '@/lib/workspace/persistence/workspace-session'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

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
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** A layout-owner build's main, applying the window's commands, with its frames drawn into
 *  `store`; nothing to open otherwise. */
async function mainWithFrames(store: ReturnType<typeof createTestStore>): Promise<() => void> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return () => {}
  }
  layoutApplyTestTransport.reset()
  layoutApplyTestTransport.useMainModel(
    loadMainLayoutModel('local', buildWorkspaceSessionPayload(store.getState()))
  )
  layoutApplyTestTransport.answerWith('apply')
  const sync = openWorkspaceLayoutFrameSync(store)
  sync.start()
  await layoutApplyTestTransport.settle()
  return () => {
    sync.close()
    endLayoutFramePositions()
  }
}

/** The user names and colors the tab; a layout-owner build's main frame draws both. */
async function titleAndColor(store: ReturnType<typeof createTestStore>, tabId: string) {
  store.getState().setTabCustomTitle(tabId, 'build shell')
  store.getState().setTabColor(tabId, '#ff0000')
  await framesDrawn()
}

/** Main's answers, and the frames they wait on, drawn. */
async function framesDrawn(): Promise<void> {
  await layoutApplyTestTransport.settle()
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

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
  it('recreates a fresh terminal with the snapshot cwd, shell, title, and color', async () => {
    const store = makeSeededStore()
    const closeMain = await mainWithFrames(store)
    onTestFinished(closeMain)
    const tab = store
      .getState()
      .createTab(WT, undefined, 'zsh', { startupCwd: '/path/wt1/packages/app' })
    await titleAndColor(store, tab.id)
    store.getState().closeTab(tab.id)
    await framesDrawn()
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(0)

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await framesDrawn()

    const restored = store.getState().tabsByWorktree[WT]
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      startupCwd: '/path/wt1/packages/app',
      shellOverride: 'zsh'
    })
    expect(restored[0]).toMatchObject({ customTitle: 'build shell', color: '#ff0000' })
    // Why: a reopened tab is a fresh surface — never the old PTY.
    expect(restored[0].id).not.toBe(tab.id)
    expect(restored[0].ptyId).toBeNull()
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toHaveLength(0)
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
