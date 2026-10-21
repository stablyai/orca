// Layout-owner build: the window's activation sweep asks main to place the workspace's unshown
// live terminals as part of its listing, then only reads the answer. A pane main names is the
// terminal's surface (main's frames draw it, maybe after the answer arrives), so the sweep writes
// nothing and its `surfaced` verdict still decides between resuming agents and seeding a shell.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import { runWorktreeAgentActivationGate } from './worktree-agent-activation-gate'
import {
  type GateTestStore,
  listed,
  LIVE_LEAF_ID,
  seedExistingSurface,
  SIBLING_LEAF_ID,
  sleepingRecord,
  testDeps,
  WORKTREE_ID
} from './worktree-agent-activation-gate.test-fixture'
import {
  readWorktreeLiveTerminalSurfaceOwners,
  type LiveTerminalSurfaceOwner
} from './worktree-live-terminal-surface-owners'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const LIVE_PTY = `${WORKTREE_ID}@@live-pty`
const MAIN_TAB = '3359f7c8-9bd8-4931-8104-52b6bdbd108d'

/** The pane main's listing names for a terminal it just placed. */
function placedByMain(ptyId: string, tabId = MAIN_TAB): LiveTerminalSurfaceOwner {
  return { paneKey: `${tabId}:${LIVE_LEAF_ID}`, ptyId, tabId }
}

function expectNoWindowWrite(store: GateTestStore): void {
  expect(store.createTab).not.toHaveBeenCalled()
  expect(store.setTabLayout).not.toHaveBeenCalled()
  expect(store.updateTabPtyId).not.toHaveBeenCalled()
  expect(store.replaceTerminalLayoutPanePtyId).not.toHaveBeenCalled()
}

beforeEach(() => {
  // Main's frames have not reached this window yet.
  provideLayoutFrameTerminalPanes({ holdsTerminalPane: () => false, terminalTab: () => undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the sweep’s listing, layout-owner build', () => {
  it('asks main to place the workspace’s unshown live terminals before it lists', async () => {
    const call = vi.fn(async () => ({
      ok: true,
      result: { terminals: [], hostScope: { hostIds: ['local'], omittedHostIds: [] } }
    }))
    vi.stubGlobal('window', { api: { runtime: { call } } })

    await readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)

    expect(call).toHaveBeenCalledWith({
      method: 'terminal.list',
      params: expect.objectContaining({
        worktree: `id:${WORKTREE_ID}`,
        requireFreshPtyLiveness: true,
        placeUnshownLiveTerminals: true
      })
    })
  })
})

describe('the activation sweep reads main’s placement, layout-owner build', () => {
  it('counts a terminal main placed as shown before its frame arrives: no shell is seeded', async () => {
    const { deps, resume } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, placedByMain(LIVE_PTY)]])
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
    expect(resume).not.toHaveBeenCalled()
  })

  it('writes nothing for a pane main names in a tab this window already has', async () => {
    const { deps } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, placedByMain(LIVE_PTY, 'tab-known')]])
    })
    seedExistingSurface(deps.getState(), { tabId: 'tab-known', leafId: LIVE_LEAF_ID })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
  })

  it('still resumes the workspace’s sleeping agent beside the terminal main placed', async () => {
    const { deps, resume } = testDeps({
      sessions: [{ ...listed(LIVE_PTY), title: 'zsh', agentOwnership: 'absent' }],
      surfaceOwners: new Map([[LIVE_PTY, placedByMain(LIVE_PTY)]]),
      sleeping: [sleepingRecord('tab-slept', SIBLING_LEAF_ID, 'slept-session')]
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('resumed')

    expect(resume).toHaveBeenCalledOnce()
    expectNoWindowWrite(deps.getState())
  })

  it('seeds no shell when nothing resumes beside the terminal main placed', async () => {
    const { deps, resume } = testDeps({
      sessions: [{ ...listed(LIVE_PTY), title: 'zsh', agentOwnership: 'absent' }],
      surfaceOwners: new Map([[LIVE_PTY, placedByMain(LIVE_PTY)]]),
      sleeping: [sleepingRecord('tab-slept', SIBLING_LEAF_ID, 'slept-session')],
      resumeCount: 0
    })

    // 'empty' would tell the caller to seed a fresh shell beside the live one.
    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(resume).toHaveBeenCalledOnce()
    expectNoWindowWrite(deps.getState())
  })
})
