import { beforeEach, describe, expect, it, vi } from 'vitest'

const DESKTOP = 'http://localhost:6080/vnc.html?autoconnect=0&reconnect=0&resize=remote'
let state: Record<string, unknown> = {}
const reopen = vi.fn(async () => {})

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/workspace/ownership/workspace-runtime-environment', () => ({
  selectWorkspaceRuntimeEnvironmentId: () => 'env-1',
  useWorkspaceRuntimeEnvironmentId: () => 'env-1'
}))
vi.mock('./open-cloud-remote-desktop', () => ({
  reopenCloudRemoteDesktopQuietly: reopen,
  openCloudRemoteDesktop: vi.fn()
}))
vi.mock('react', () => ({
  useEffect: (fn: () => void) => fn(),
  useMemo: (fn: () => unknown) => fn()
}))

const {
  hasRemoteDesktopToReopen,
  noteRemoteDesktopBeforeSleep,
  resetRemoteDesktopSleepReopenForTest,
  useReopenRemoteDesktopAfterWake
} = await import('./desktop-sleep-reopen')

describe('remote desktop across sleep', () => {
  beforeEach(() => {
    resetRemoteDesktopSleepReopenForTest()
    reopen.mockClear()
  })

  it('remembers a desktop tab that sleep closes and reopens it once the workspace runs', () => {
    state = {
      activeWorktreeId: 'w1',
      activeTabType: 'browser',
      activeBrowserTabId: 'tab-d',
      browserTabsByWorktree: {
        w1: [
          { id: 'tab-b', url: 'https://example.com' },
          { id: 'tab-d', url: DESKTOP }
        ]
      }
    }
    noteRemoteDesktopBeforeSleep('w1')
    expect(hasRemoteDesktopToReopen('w1')).toBe(true)
    useReopenRemoteDesktopAfterWake('w1', false)
    expect(reopen).not.toHaveBeenCalled()
    useReopenRemoteDesktopAfterWake('w1', true)
    expect(reopen).toHaveBeenCalledWith('w1', 'env-1', true)
    // Once only.
    useReopenRemoteDesktopAfterWake('w1', true)
    expect(reopen).toHaveBeenCalledTimes(1)
  })

  it('reopens a desktop that was behind another tab without bringing it to the front', () => {
    state = {
      activeWorktreeId: 'w1',
      activeTabType: 'terminal',
      activeBrowserTabId: null,
      browserTabsByWorktree: { w1: [{ id: 'tab-d', url: DESKTOP }] }
    }
    noteRemoteDesktopBeforeSleep('w1')
    useReopenRemoteDesktopAfterWake('w1', true)
    expect(reopen).toHaveBeenCalledWith('w1', 'env-1', false)
  })

  it('does nothing for a workspace without a desktop tab', () => {
    state = { browserTabsByWorktree: { w1: [{ id: 'tab-b', url: 'http://localhost:3000/' }] } }
    noteRemoteDesktopBeforeSleep('w1')
    expect(hasRemoteDesktopToReopen('w1')).toBe(false)
  })
})
