// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'

const mocks = vi.hoisted(() => ({ attach: vi.fn(), createBrowserTab: vi.fn(async () => true) }))

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))
vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
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
})
