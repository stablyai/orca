import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchTabPublishRequest } from '../../../shared/agent-launch-tab-publication'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => {
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
vi.mock('@/runtime/layout-frame-position', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  layoutFramesFlowing: () => frames.flowing
}))
vi.mock('@/runtime/layout-frame-terminal-panes', () => ({
  layoutFrameTerminalTab: () => (frames.holdsTab ? { id: 'main-tab' } : undefined)
}))
const revealWorkspaceSurface = vi.hoisted(() => vi.fn())
vi.mock('./workspace-surface-reveal', () => ({ revealWorkspaceSurface }))

createTabsSliceMockApi()

const { keepAgentLaunchTabMainWrote, _resetUndrawnLaunchTabsForTests } =
  await import('./agent-launch-tab-main-written')
const { applyAgentLaunchPaneVerdict } = await import('./agent-launch-pane-verdict-application')
const { agentLaunchPanePrompt } = await import('./agent-launch-pane-prompt')

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
  it('moves the view as the viewer rule says, only for the launch that made the tab', () => {
    drawMainTab()
    keepAgentLaunchTabMainWrote(
      request({ viewer: 'focus-in-workspace', shownByMain: { created: false } })
    )
    expect(focusTerminalInitiatedTab).not.toHaveBeenCalled()

    keepAgentLaunchTabMainWrote(request({ requestId: 'r-2', viewer: 'focus-in-workspace' }))
    expect(store.getState().activeTabId).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).toHaveBeenCalledWith(TAB_ID, LEAF_ID, WT)
  })

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

  it('drops a settled launch of a tab that draws later', () => {
    keepAgentLaunchTabMainWrote(request({ prompt: 'fix the build' }))
    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      verdict: { kind: 'proceed' }
    })

    drawMainTab()

    expect(launchPane()).toBeUndefined()
    expect(agentLaunchPanePrompt(TAB_ID)).toBeNull()
  })

  it('leaves the close of a withdrawn tab to main, and drops what it kept', () => {
    drawMainTab()
    keepAgentLaunchTabMainWrote(request({ prompt: 'fix the build' }))

    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      verdict: { kind: 'withdrawn' }
    })

    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(launchPane()).toBeUndefined()
    expect(agentLaunchPanePrompt(TAB_ID)).toBeNull()
  })

  it('drops a held launch once main closed its tab, never drawn', () => {
    frames.flowing = true
    keepAgentLaunchTabMainWrote(request({ prompt: 'fix the build' }))
    frames.holdsTab = false

    store.setState({})
    expect(agentLaunchPanePrompt(TAB_ID)).toBeNull()
    frames.holdsTab = true
    drawMainTab()
    expect(launchPane()).toBeUndefined()
  })
})
