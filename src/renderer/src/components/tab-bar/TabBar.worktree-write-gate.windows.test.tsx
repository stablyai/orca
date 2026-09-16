// @vitest-environment happy-dom

/**
 * Windows half of the tab-strip worktree-write gate. `isWindows` is read once at module
 * load, so the two client platforms cannot share a file; see
 * TabBar.worktree-write-gate.test.tsx for the non-Windows half and the full rationale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  createTabBarProbeStore,
  localProjectRuntimeSpy,
  probeWindowsCapabilities,
  pushWorktreeWrite,
  TAB_BAR_PROBE_PROPS,
  tabBarRuntimeModelStubs,
  tabBarShellStubs,
  tabBarSurfaceRenders
} from './use-tab-bar-runtime-model-worktree-write-probe'
import type { TabBarProps } from './tab-bar-props'

vi.mock('@/store', async () => ({ useAppStore: await createTabBarProbeStore() }))
vi.mock('../../store', async () => ({ useAppStore: await createTabBarProbeStore() }))
vi.mock('@/hooks/useShortcutLabel', () => tabBarRuntimeModelStubs().shortcutLabels())
vi.mock('@/hooks/useDetectedAgents', () => tabBarRuntimeModelStubs().detectedAgents())
vi.mock('@/hooks/useAgentDetectionTarget', () => tabBarRuntimeModelStubs().detectionTarget())
vi.mock('@/lib/connection-context', () => tabBarRuntimeModelStubs().connectionContext())
vi.mock('@/lib/worktree-runtime-owner', () => tabBarRuntimeModelStubs().runtimeOwner())
vi.mock('@/runtime/runtime-rpc-client', () => tabBarRuntimeModelStubs().runtimeRpcClient())
vi.mock('@/lib/native-chat-transcript-readability', () =>
  tabBarRuntimeModelStubs().nativeChatReadability()
)
vi.mock('@/lib/client-creation-action-policy', () => tabBarRuntimeModelStubs().creationPolicy())
vi.mock('./tab-agent-types-by-tab-id', () => tabBarRuntimeModelStubs().agentProjections())
vi.mock('@/lib/local-preflight-context', () => tabBarRuntimeModelStubs().localPreflight())
vi.mock('@/lib/windows-terminal-capabilities', () =>
  tabBarRuntimeModelStubs().windowsCapabilities()
)
vi.mock('./tab-bar-surface', () => tabBarShellStubs().surface())
vi.mock('./use-tab-bar-create-menu-controller', () => tabBarShellStubs().createMenuController())
vi.mock('./use-tab-bar-item-projection', () => tabBarShellStubs().itemProjection())
vi.mock('./tab-strip-overflow-navigation', () => tabBarShellStubs().overflowNavigation())
vi.mock('./tab-strip-drag-scroll', () => tabBarShellStubs().dragScroll())
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () =>
  tabBarShellStubs().clientHostedBrowserRows()
)

const WORKTREE_WRITES = 25

describe('TabBar worktree-write gate (Windows client)', () => {
  beforeEach(async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    })
    // A Windows client gets the shell menu before its capability probe resolves.
    probeWindowsCapabilities.hostPlatform = null
    tabBarSurfaceRenders.count = 0
    localProjectRuntimeSpy.mockClear()
    ;(await createTabBarProbeStore()).setState({ worktreesByRepo: {}, projects: [], repos: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps recomputing the local project runtime on every worktree write', async () => {
    const store = await createTabBarProbeStore()
    const { default: TabBar } = await import('./TabBar')
    render(<TabBar {...(TAB_BAR_PROBE_PROPS as unknown as TabBarProps)} />)
    const rendersAtMount = tabBarSurfaceRenders.count
    const runtimeCallsAtMount = localProjectRuntimeSpy.mock.calls.length
    expect(runtimeCallsAtMount).toBeGreaterThan(0)

    for (let tick = 0; tick < WORKTREE_WRITES; tick += 1) {
      await act(async () => {
        pushWorktreeWrite(store, tick)
      })
    }

    expect(tabBarSurfaceRenders.count).toBe(rendersAtMount + WORKTREE_WRITES)
    expect(localProjectRuntimeSpy.mock.calls.length).toBe(runtimeCallsAtMount + WORKTREE_WRITES)
  })
})
