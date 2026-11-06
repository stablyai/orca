import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchPaneVerdict } from '../../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))
const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
const applyClosedTerminalLeafNotice = vi.hoisted(() => vi.fn())
vi.mock('@/components/terminal-pane/closed-terminal-leaf-notice', () => ({
  applyClosedTerminalLeafNotice
}))

createTabsSliceMockApi()

const { applyAgentLaunchPaneVerdict } = await import('./agent-launch-pane-verdict-application')
const { agentLaunchPanePrompt, rememberAgentLaunchPanePrompt } =
  await import('./agent-launch-pane-prompt')

const WT = 'repo1::/tmp/feature'
const LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
let store: ReturnType<typeof createTestStore>
let tabId: string

function launchTab() {
  return store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === tabId)
}

function apply(verdict: AgentLaunchPaneVerdict, leafId = LEAF): void {
  applyAgentLaunchPaneVerdict({ worktreeId: WT, tabId, leafId, verdict })
}

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  applyClosedTerminalLeafNotice.mockClear()
  store.getState().setActiveWorktree(WT)
  tabId = store.getState().createTab(WT, undefined, undefined, {
    initialLeafId: LEAF,
    agentLaunchPane: { leafId: LEAF, operationId: 'op-1' }
  }).id
  rememberAgentLaunchPanePrompt(tabId, 'fix the build')
})

describe("a launch pane's verdict in the window", () => {
  it('final, for a launch pane the user already closed out of a split: nothing is kept', () => {
    store.getState().setTabLayout(tabId, {
      root: { type: 'leaf', leafId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
      activeLeafId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      expandedLeafId: null
    })
    apply({ kind: 'not-started', code: 'agent_launch_tab_closed' })
    expect(launchTab()?.agentLaunchPane).toBeUndefined()
    expect(agentLaunchPanePrompt(tabId)).toBeNull()
  })
})
