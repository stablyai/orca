// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  beginWorkspaceWake: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  resumeWorkspace: vi.fn()
}))

vi.mock('@/components/terminal-pane/input/wake-input-buffer', () => ({
  beginWorkspaceWake: mocks.beginWorkspaceWake,
  endWorkspaceWake: vi.fn()
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

const WS = 'cloud-wt'
const PRESS = 1_800_000_000_000

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', { ephemeralVm: { resumeWorkspace: mocks.resumeWorkspace } })
})
afterEach(() => {
  resetWakeAfterSleepForTests()
  resetWorktreeSleepViewForTests()
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

  it('opening it before the suspend is committed still wakes the ordinary way', async () => {
    holdWorktreeSleepView(WS)
    mocks.resumeWorkspace.mockResolvedValue({ ok: true })
    await activateWorktreeFromSidebar(WS)
    expect(hasWakeAfterSleepRequest(WS)).toBe(false)
    expect(isWorktreeSleepViewHeld(WS)).toBe(false)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalled()
  })
})
