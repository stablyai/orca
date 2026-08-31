// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS } from '../../../../shared/browser-client-page-creation-timeouts'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'

const mocks = vi.hoisted(() => ({ attach: vi.fn(), createBrowserTab: vi.fn(async () => true) }))

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createBrowserTab
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), message: vi.fn() }
}))

import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'
import { RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS } from './restored-client-hosted-recovery-window'

const PAGE_ID = 'page-a'
const ENVIRONMENT_ID = 'environment-a'

function page(): BrowserPage {
  return {
    id: PAGE_ID,
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'https://remote.internal/saved',
    title: 'Saved',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

// 'absent' is the cold-relaunch shape: the pane mounts before any status has been recorded for the
// environment, so the entry does not exist yet rather than existing with a null status.
type EnvironmentReachability = 'reachable' | 'unreachable' | 'absent'

function runtimeStatusMap(
  reachability: EnvironmentReachability
): Map<string, { status: RuntimeStatus | null; checkedAt: number }> {
  if (reachability === 'absent') {
    return new Map()
  }
  return new Map([
    [
      ENVIRONMENT_ID,
      {
        status: reachability === 'reachable' ? ({ runtimeId: 'runtime-a' } as RuntimeStatus) : null,
        checkedAt: 1
      }
    ]
  ])
}

function seedStore(options: { restored: boolean; environment: EnvironmentReachability }): void {
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: options.restored
      ? {
          [PAGE_ID]: {
            environmentId: ENVIRONMENT_ID,
            remotePageId: 'remote-page-a',
            restoredFromSession: true,
            restoredClientHosted: true
          }
        }
      : {
          [PAGE_ID]: {
            environmentId: ENVIRONMENT_ID,
            remotePageId: 'remote-page-a',
            staged: true,
            stagedClientHosted: true
          }
        },
    runtimeStatusByEnvironmentId: runtimeStatusMap(options.environment)
  })
}

function paneElement(): React.JSX.Element {
  return (
    <TooltipProvider>
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId={ENVIRONMENT_ID}
        worktreeId="worktree-a"
        placement={null}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    </TooltipProvider>
  )
}

function renderPane(): ReturnType<typeof render> {
  return render(paneElement())
}

// Scoped to the navigation row: the unavailable notice's reopen button keeps its own pending
// spinner in the DOM at all times, hidden by class, so an unscoped query is always true.
function spinnerShown(): boolean {
  return (
    document.querySelector(
      '[data-contextual-tour-target="client-hosted-browser-controls"] .animate-spin'
    ) !== null
  )
}

function noticeShown(): boolean {
  return screen.queryByText('Client-hosted browser unavailable') !== null
}

describe('restored client-hosted recovery window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.attach.mockReset()
    installClientHostedPaneApi()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState({
      remoteBrowserPageHandlesByPageId: {},
      runtimeStatusByEnvironmentId: new Map()
    })
  })

  it('keeps waiting while the window is still open', () => {
    seedStore({ restored: true, environment: 'reachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS - 1))

    expect(spinnerShown()).toBe(true)
    expect(noticeShown()).toBe(false)
  })

  it('stops waiting and offers the reopen escape once the window elapses', () => {
    seedStore({ restored: true, environment: 'reachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS))

    expect(noticeShown()).toBe(true)
    expect(spinnerShown()).toBe(false)
    expect(screen.getByRole('button', { name: 'Reopen on server' })).not.toBeNull()
  })

  // Why the row itself is checked: deleting it is the failure mode this replaced. The user decides.
  it('leaves the page row in place when it gives up', () => {
    seedStore({ restored: true, environment: 'reachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS))

    expect(useAppStore.getState().remoteBrowserPageHandlesByPageId[PAGE_ID]).not.toBeUndefined()
  })

  // Why: nobody has asked the host yet, and the environment's own disconnected state says so.
  it('keeps waiting indefinitely while the environment is unreachable', () => {
    seedStore({ restored: true, environment: 'unreachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS * 10))

    expect(spinnerShown()).toBe(true)
    expect(noticeShown()).toBe(false)
  })

  // Why the environment starts with no entry at all rather than an unreachable one: this is the
  // ordering production always takes. A cold relaunch mounts the pane from the persisted row before
  // any runtime status has been recorded, so the effect's re-run on the flip is the only thing that
  // ever arms the clock — every other case here seeds the status first and never takes that path.
  it('arms the window when the environment first becomes reachable', () => {
    seedStore({ restored: true, environment: 'absent' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS * 2))
    expect(noticeShown()).toBe(false)

    act(() => {
      useAppStore.setState({ runtimeStatusByEnvironmentId: runtimeStatusMap('reachable') })
    })

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS - 1))
    expect(noticeShown()).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(noticeShown()).toBe(true)
  })

  // Why the staged case is pinned separately: it also mounts with a null placement, but its host is
  // mid-create rather than absent, and the create path has its own bound.
  it('leaves a staged page that is not restored alone', () => {
    seedStore({ restored: false, environment: 'reachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS * 10))

    expect(spinnerShown()).toBe(true)
    expect(noticeShown()).toBe(false)
  })

  // Why revocable: the window is a bound on waiting, not a verdict on the page. A slow recovery
  // that lands after it must put the user back on their page rather than on a dead notice.
  it('takes the notice back when the placement finally arrives', () => {
    seedStore({ restored: true, environment: 'reachable' })
    renderPane()
    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS))
    expect(noticeShown()).toBe(true)

    act(() => {
      useAppStore.setState({
        remoteBrowserPageHandlesByPageId: {
          [PAGE_ID]: { environmentId: ENVIRONMENT_ID, remotePageId: 'remote-page-a' }
        }
      })
    })

    expect(noticeShown()).toBe(false)
  })

  // Why re-entry gets its own case: a host fence clears the placement and re-runs recovery, so the
  // pane returns to waiting. A window that stayed spent would answer the second wait instantly.
  it('waits again when a recovered page loses its placement', () => {
    seedStore({ restored: true, environment: 'reachable' })
    const view = renderPane()
    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS))
    act(() => {
      useAppStore.setState({
        remoteBrowserPageHandlesByPageId: {
          [PAGE_ID]: { environmentId: ENVIRONMENT_ID, remotePageId: 'remote-page-a' }
        }
      })
    })
    expect(noticeShown()).toBe(false)

    act(() => {
      useAppStore.setState({
        remoteBrowserPageHandlesByPageId: {
          [PAGE_ID]: {
            environmentId: ENVIRONMENT_ID,
            remotePageId: 'remote-page-a',
            restoredFromSession: true,
            restoredClientHosted: true
          }
        }
      })
      view.rerender(paneElement())
    })

    expect(noticeShown()).toBe(false)
    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS - 1))
    expect(noticeShown()).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(noticeShown()).toBe(true)
  })

  // Why the number is asserted and not only derived from: every boundary case above stays green if
  // the window shrinks to a millisecond, and a window shorter than one creation attempt would call
  // the first batch of recoveries dead. The first batch is all this bounds — recovery runs four
  // pages at a time and each awaits a create and then a navigate, so with 9+ restored tabs a page
  // can see the notice while its turn has not come. Widening to the batched bound is ledgered.
  it('waits longer than the runtime spends creating one client page in the first batch', () => {
    expect(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS).toBe(45_000)
    // Imported, not copied: a locally re-declared ceiling makes raising the runtime's own timeout
    // invisible here, which is the one change that could turn this window into a false verdict.
    expect(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS).toBeGreaterThan(
      DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS
    )
  })
})
