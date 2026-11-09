import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchTabPublishRequest } from '../../../../../../shared/agent-launch/contracts/agent-launch-tab-publication'
import { createTabsSliceMockApi } from '../../../../store/slices/tabs/tabs-slice-test-harness'
import { createTestStore } from '../../../../store/testing/app-store-test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store/index', () => {
  const current = () => {
    if (!testStore.current) {
      throw new Error('no test store')
    }
    return testStore.current
  }
  return {
    useAppStore: {
      getState: () => current().getState(),
      subscribe: (listener: () => void) => current().subscribe(listener)
    }
  }
})
const focusTerminalInitiatedTab = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/ipc-events/terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  focusTerminalInitiatedTab
}))

const frames = vi.hoisted(() => ({ flowing: false, holdsTab: true }))
vi.mock('@/runtime/workspace-layout/frames/layout-frame-position', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  layoutFramesFlowing: () => frames.flowing
}))
vi.mock('@/runtime/workspace-layout/frames/layout-frame-terminal-panes', () => ({
  layoutFrameTerminalTab: () => (frames.holdsTab ? { id: 'main-tab' } : undefined)
}))
const revealWorkspaceSurface = vi.hoisted(() => vi.fn())
vi.mock('../../../workspace-surface-reveal', () => ({ revealWorkspaceSurface }))

createTabsSliceMockApi()

const { keepAgentLaunchTabMainWrote, _resetUndrawnLaunchTabsForTests } =
  await import('./agent-launch-tab-main-written')
const { applyAgentLaunchPaneVerdict } = await import('./agent-launch-pane-verdict-application')

const WT = 'repo1::/tmp/feature'
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

let store: ReturnType<typeof createTestStore>

function request(
  overrides: Partial<AgentLaunchTabPublishRequest> = {}
): AgentLaunchTabPublishRequest {
  return {
    requestId: 'request-1',
    worktreeId: WT,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    viewMode: 'terminal',
    viewer: 'none',
    operationId: 'op-1',
    shownByMain: { frameSeq: 3, created: true },
    ...overrides
  }
}

function drawMainTab(): void {
  store.getState().createTab(WT, undefined, undefined, {
    id: TAB_ID,
    initialLeafId: LEAF_ID,
    activate: false
  })
}

const launchPane = () =>
  store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)?.agentLaunchPane

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  focusTerminalInitiatedTab.mockClear()
  store.getState().setActiveWorktree(WT)
})
afterEach(() => {
  _resetUndrawnLaunchTabsForTests()
  frames.flowing = false
  frames.holdsTab = true
  revealWorkspaceSurface.mockClear()
})

describe("a launch tab main wrote, in a layout-owner build's window", () => {
  it('keeps the launch, and an outcome that came first, for a tab that draws later', () => {
    keepAgentLaunchTabMainWrote(request())
    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      verdict: { kind: 'unconfirmed' }
    })

    drawMainTab()

    expect(launchPane()).toEqual({
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'unconfirmed' }
    })
  })
})
