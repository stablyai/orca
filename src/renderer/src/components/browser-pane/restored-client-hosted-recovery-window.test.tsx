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
vi.mock('@/runtime/web-runtime-browser-creation', () => ({
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

// Cold relaunch mounts persisted panes before any environment status entry exists.
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

function loadingShown(): boolean {
  return (
    document.querySelector(
      '[data-contextual-tour-target="client-hosted-browser-controls"] [data-browser-load-progress="loading"]'
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

    expect(loadingShown()).toBe(true)
    expect(noticeShown()).toBe(false)
  })

  it('stops waiting and offers the reopen escape once the window elapses', () => {
    seedStore({ restored: true, environment: 'reachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS))

    expect(noticeShown()).toBe(true)
    expect(loadingShown()).toBe(false)
    expect(screen.getByRole('button', { name: 'Reopen on server' })).not.toBeNull()
  })

  it('leaves the page row in place when it gives up', () => {
    seedStore({ restored: true, environment: 'reachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS))

    expect(useAppStore.getState().remoteBrowserPageHandlesByPageId[PAGE_ID]).not.toBeUndefined()
  })

  it('keeps waiting indefinitely while the environment is unreachable', () => {
    seedStore({ restored: true, environment: 'unreachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS * 10))

    expect(loadingShown()).toBe(true)
    expect(noticeShown()).toBe(false)
  })

  // Seed no status to exercise cold-start reachability arming the clock after mount.
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

  // Staged pages also lack placement, but their in-flight create has its own timeout.
  it('leaves a staged page that is not restored alone', () => {
    seedStore({ restored: false, environment: 'reachable' })
    renderPane()

    act(() => vi.advanceTimersByTime(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS * 10))

    expect(loadingShown()).toBe(true)
    expect(noticeShown()).toBe(false)
  })

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

  // The first recovery batch needs a full creation attempt before any unavailable notice.
  it('waits longer than the runtime spends creating one client page in the first batch', () => {
    // Import the runtime ceiling so increases cannot silently invalidate this window.
    expect(RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS).toBeGreaterThan(
      DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS
    )
  })
})
