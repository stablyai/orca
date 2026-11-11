// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  beginWorkspaceWake: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  holdActiveCloudSleepView: vi.fn(() => true),
  resumeWorkspace: vi.fn()
}))

vi.mock('@/components/terminal-pane/input/wake-input-buffer', () => ({
  beginWorkspaceWake: mocks.beginWorkspaceWake,
  endWorkspaceWake: vi.fn()
}))
vi.mock('@/components/sidebar/workspace-actions/sleep/workspace-sleep-view-hold', () => ({
  holdActiveCloudSleepView: mocks.holdActiveCloudSleepView
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import {
  clearWakeAfterSleepRequest,
  hasWakeAfterSleepRequest,
  noteWakeAfterSleepSleepEnded,
  requestWakeAfterSleep,
  resetWakeAfterSleepForTests,
  useWakeAfterSleep,
  wakeAfterSleepStartedAt
} from './worktree-sleep-wake-request'
import {
  holdWorktreeSleepView,
  isWorktreeSleepViewHeld,
  markWorktreeSuspendCommitted,
  resetWorktreeSleepViewForTests
} from './worktree-sleep-view'
import { activateWorktreeFromSidebar } from './workspace/activation/sidebar-worktree-activation'
import { forgetWorktreeSleepIntent, hasWorktreeSleepIntent } from './worktree-sleep-intent'

const WS = 'cloud-wt'
const PRESS = 1_800_000_000_000

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', { ephemeralVm: { resumeWorkspace: mocks.resumeWorkspace } })
})
afterEach(() => {
  resetWakeAfterSleepForTests()
  resetWorktreeSleepViewForTests()
  forgetWorktreeSleepIntent(WS)
  vi.unstubAllGlobals()
  cleanup()
})

describe('wake pressed while main suspends the VM', () => {
  it('shows as waking from the press, and holds typing from then on', () => {
    const { result } = renderHook(() => useWakeAfterSleep(WS))
    expect(result.current).toBeUndefined()
    act(() => requestWakeAfterSleep(WS, PRESS))
    expect(result.current).toEqual({
      workspaceId: WS,
      phase: 'waking',
      source: 'open',
      startedAt: PRESS,
      at: PRESS
    })
    expect(mocks.beginWorkspaceWake).toHaveBeenCalledWith(WS, PRESS)
    // Stale counts from the end of the sleep (main can only report after it).
    act(() => noteWakeAfterSleepSleepEnded(WS, PRESS + 4_000))
    expect(result.current?.at).toBe(PRESS + 4_000)
    act(() => clearWakeAfterSleepRequest(WS))
    expect(result.current).toBeUndefined()
  })

  it("main's reports for the wake count from the press; an older wake's do not", () => {
    expect(wakeAfterSleepStartedAt(WS, PRESS + 5_000)).toBe(PRESS + 5_000)
    requestWakeAfterSleep(WS, PRESS)
    expect(wakeAfterSleepStartedAt(WS, PRESS + 5_000)).toBe(PRESS)
    expect(wakeAfterSleepStartedAt(WS, PRESS - 1)).toBe(PRESS - 1)
    expect(wakeAfterSleepStartedAt('other', PRESS + 5_000)).toBe(PRESS + 5_000)
  })

  it('opening the workspace kept on screen while main suspends waits instead of waking now', async () => {
    holdWorktreeSleepView(WS)
    markWorktreeSuspendCommitted(WS)
    await expect(activateWorktreeFromSidebar(WS)).resolves.toEqual({ ok: true })
    expect(hasWakeAfterSleepRequest(WS)).toBe(true)
    // Still the read-only view, not a re-activation or a resume: no dead panes, no early wake.
    expect(isWorktreeSleepViewHeld(WS)).toBe(true)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.resumeWorkspace).not.toHaveBeenCalled()
  })

  it('re-opening it from its row after leaving mid-sleep selects it, kept asleep, and waits', async () => {
    // Left during the sleep: the read-only hold ended with the selection.
    markWorktreeSuspendCommitted(WS)
    await expect(activateWorktreeFromSidebar(WS)).resolves.toEqual({ ok: true })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ navigationIntent: 'user-open' })
    )
    // Selecting clears sleep intent; it is put back (and the view held) right after, before any
    // pane mounts, so the panes wait for the wake instead of attaching to a VM going down.
    expect(hasWorktreeSleepIntent(WS)).toBe(true)
    expect(mocks.holdActiveCloudSleepView).toHaveBeenCalledWith(WS)
    expect(mocks.holdActiveCloudSleepView.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]
    )
    expect(hasWakeAfterSleepRequest(WS)).toBe(true)
    expect(mocks.resumeWorkspace).not.toHaveBeenCalled()
  })

  it('opening it before the suspend is committed still wakes the ordinary way', async () => {
    holdWorktreeSleepView(WS)
    mocks.resumeWorkspace.mockResolvedValue({ ok: true })
    await activateWorktreeFromSidebar(WS)
    expect(hasWakeAfterSleepRequest(WS)).toBe(false)
    expect(isWorktreeSleepViewHeld(WS)).toBe(false)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalled()
  })
})
