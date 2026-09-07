// @vitest-environment happy-dom

/**
 * The tab strip must not wake on worktree writes. `projects`/`repos`/`worktreesByRepo`
 * exist in the runtime model only to build the Windows shell menu's local project
 * runtime; `worktreesByRepo` gets a new identity on every poller result, head-identity
 * refresh and git-status write, so an ungated subscription re-renders and re-commits
 * every mounted tab strip continuously on a large install.
 *
 * Runs as a non-Windows client. The menu-on branch is exercised through a `win32`
 * host platform, which is how a paired web client on macOS legitimately gets the menu.
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
  tabBarSurfaceRenders,
  type TabBarProbeStore
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

async function renderTabBar(): Promise<void> {
  const { default: TabBar } = await import('./TabBar')
  render(<TabBar {...(TAB_BAR_PROBE_PROPS as unknown as TabBarProps)} />)
}

/** One commit per write, not one batched commit, so the render count is the real one. */
async function pushWorktreeWrites(store: TabBarProbeStore): Promise<void> {
  for (let tick = 0; tick < WORKTREE_WRITES; tick += 1) {
    await act(async () => {
      pushWorktreeWrite(store, tick)
    })
  }
}

describe('TabBar worktree-write gate (non-Windows client)', () => {
  beforeEach(async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })
    probeWindowsCapabilities.hostPlatform = 'darwin'
    tabBarSurfaceRenders.count = 0
    localProjectRuntimeSpy.mockClear()
    ;(await createTabBarProbeStore()).setState({ worktreesByRepo: {}, projects: [], repos: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('does not re-render the tab strip when worktree writes republish worktreesByRepo', async () => {
    const store = await createTabBarProbeStore()
    await renderTabBar()
    const rendersAtMount = tabBarSurfaceRenders.count
    expect(rendersAtMount).toBeGreaterThan(0)

    await pushWorktreeWrites(store)

    expect(tabBarSurfaceRenders.count).toBe(rendersAtMount)
    expect(localProjectRuntimeSpy).not.toHaveBeenCalled()
  })

  it('still tracks worktree writes when the Windows shell menu is on', async () => {
    const store = await createTabBarProbeStore()
    probeWindowsCapabilities.hostPlatform = 'win32'
    await renderTabBar()
    const rendersAtMount = tabBarSurfaceRenders.count
    const runtimeCallsAtMount = localProjectRuntimeSpy.mock.calls.length
    expect(runtimeCallsAtMount).toBeGreaterThan(0)

    await pushWorktreeWrites(store)

    expect(tabBarSurfaceRenders.count).toBe(rendersAtMount + WORKTREE_WRITES)
    expect(localProjectRuntimeSpy.mock.calls.length).toBe(runtimeCallsAtMount + WORKTREE_WRITES)
  })
})
