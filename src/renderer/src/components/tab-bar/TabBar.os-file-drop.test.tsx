// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTabBarProbeStore,
  TAB_BAR_PROBE_PROPS,
  tabBarRuntimeModelStubs,
  tabBarShellStubs
} from './use-tab-bar-runtime-model-worktree-write-probe'
import type { TabBarProps } from './tab-bar-props'

const mocks = vi.hoisted(() => ({ capture: vi.fn(), deliver: vi.fn() }))

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
// The real surface needs the full menu model; this one only renders the strip root it is handed.
vi.mock('./tab-bar-surface', () => ({
  renderTabBarSurface: ({ surfaceRef }: { surfaceRef?: (node: HTMLDivElement | null) => void }) => (
    <div ref={surfaceRef} data-testid="tab-strip">
      <span data-testid="tab" />
    </div>
  )
}))
vi.mock('./use-tab-bar-create-menu-controller', () => ({
  useTabBarCreateMenuController: () => ({ clearPendingNewTabMenuFocusOnUnmount: () => undefined })
}))
vi.mock('./use-tab-bar-item-projection', () => tabBarShellStubs().itemProjection())
vi.mock('./tab-strip-overflow-navigation', () => tabBarShellStubs().overflowNavigation())
vi.mock('./tab-strip-drag-scroll', () => tabBarShellStubs().dragScroll())
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () =>
  tabBarShellStubs().clientHostedBrowserRows()
)
vi.mock('../editor/editor-dropped-file-open', () => ({
  captureEditorFileDropOpen: mocks.capture,
  editorGroupStillExists: () => true
}))

function dropFile(target: Element): void {
  const transfer = { types: ['Files'], files: [new File(['x'], 'a.ts')], dropEffect: 'move' }
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
}

beforeEach(async () => {
  ;(await createTabBarProbeStore()).setState({ activeWorktreeId: 'wt-active' })
  mocks.capture.mockImplementation(() => mocks.deliver)
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/Users/me/${file.name}`,
      prepareDroppedPaths: async ({ paths }: { paths: string[] }) => ({ paths, failures: [] })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('TabBar OS file drops', () => {
  it("opens a file dropped on the strip in the strip's own worktree and group", async () => {
    const { default: TabBar } = await import('./TabBar')
    const props: TabBarProps = { ...TAB_BAR_PROBE_PROPS, tabs: [], groupId: 'group-target' }
    const view = render(<TabBar {...props} />)
    dropFile(view.getByTestId('tab'))
    expect(mocks.capture).toHaveBeenCalledWith({ worktreeId: 'wt-target', groupId: 'group-target' })
    await waitFor(() => expect(mocks.deliver).toHaveBeenCalledWith(['/Users/me/a.ts']))
  })
})
