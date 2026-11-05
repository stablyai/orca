// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ACTIVE = 'wt-active'
const AGENT = 'wt-agent'
const RECENT_HIDDEN = ['wt-d', 'wt-c', 'wt-b', 'wt-a']
const SURFACES = [ACTIVE, ...RECENT_HIDDEN, AGENT]
const SURFACE_ID_SET = new Set(SURFACES)

const mocks = vi.hoisted(() => ({ destroyWorktreeBrowserGuests: vi.fn() }))

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({
      browserTabsByWorktree: Object.fromEntries(
        SURFACES.map((worktreeId) => [
          worktreeId,
          [{ id: `tab-${worktreeId}`, pageIds: [`page-${worktreeId}`] }]
        ])
      ),
      browserPagesByWorkspace: {}
    })
  }
}))
vi.mock('../store/slices/browser-webview-cleanup', () => ({
  destroyWorktreeBrowserGuests: (_tabs: unknown, _pages: unknown, worktreeId: string) =>
    mocks.destroyWorktreeBrowserGuests(worktreeId)
}))
vi.mock('./browser-pane/host-guest/webview-registry', () => ({
  hasLiveBrowserGuest: () => true
}))
vi.mock('./browser-pane/navigate/browser-page-download-activity', () => ({
  installBrowserPageDownloadActivityTracking: () => () => {},
  hasActiveBrowserPageDownload: () => false
}))

const { acquireBrowserAutomationVisibility, releaseBrowserAutomationVisibility } =
  await import('./browser-pane/host-guest/browser-automation-visibility')
const { useTerminalBrowserRetention } = await import('./use-terminal-browser-retention')

function renderRetention(): void {
  renderHook(() => {
    const [revision, setRevision] = useState(0)
    const recencyRef = useRef([...RECENT_HIDDEN])
    const mountedRef = useRef(new Set(SURFACES))
    useTerminalBrowserRetention({
      browserGuestRetentionBudgetEnabled: true,
      browserGuestRetentionRevision: revision,
      browserGuestWorktreeRecencyRef: recencyRef,
      mountedWorktreeIdsRef: mountedRef,
      renderedActiveWorktreeId: ACTIVE,
      setBrowserGuestRetentionRevision: setRevision,
      workspaceSurfaceIds: SURFACES,
      workspaceSurfaceIdSet: SURFACE_ID_SET
    })
  })
}

afterEach(() => {
  cleanup()
  mocks.destroyWorktreeBrowserGuests.mockReset()
})

describe('useTerminalBrowserRetention', () => {
  it('keeps a hidden worktree an agent just drove when its automation lease lapses', () => {
    renderRetention()
    mocks.destroyWorktreeBrowserGuests.mockReset()

    let token = ''
    act(() => {
      token = acquireBrowserAutomationVisibility(`page-${AGENT}`)
    })
    act(() => {
      releaseBrowserAutomationVisibility(token)
    })

    const evicted = mocks.destroyWorktreeBrowserGuests.mock.calls.map(([worktreeId]) => worktreeId)
    expect(evicted).not.toContain(AGENT)
    expect(evicted).toContain('wt-a')
  })
})
