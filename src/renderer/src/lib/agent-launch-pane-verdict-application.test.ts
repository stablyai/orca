import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchPaneVerdict } from '../../../shared/agent-launch-pane-verdict'
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
const { wasAgentLaunchPaneClosedByUser } = await import('./agent-launch-pane-closes')

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
  it('settled: the tab forgets the launch and its prompt, so a restart reads nothing for it', () => {
    apply({ kind: 'proceed' })
    expect(launchTab()?.agentLaunchPane).toBeUndefined()
    expect(agentLaunchPanePrompt(tabId)).toBeNull()
  })

  it('final: the tab keeps it for its life', () => {
    apply({ kind: 'unconfirmed' })
    expect(launchTab()?.agentLaunchPane).toEqual({
      leafId: LEAF,
      operationId: 'op-1',
      outcome: { kind: 'unconfirmed' }
    })
    expect(agentLaunchPanePrompt(tabId)).toBe('fix the build')
  })

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

  it('withdrawn: a tab with only the launch pane goes', () => {
    apply({ kind: 'withdrawn' })
    expect(launchTab()).toBeUndefined()
  })

  it('withdrawn: a split the user added stays; only the launch pane closes', () => {
    store.getState().setTabLayout(tabId, {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF },
        second: { type: 'leaf', leafId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' }
      },
      activeLeafId: LEAF,
      expandedLeafId: null
    })
    apply({ kind: 'withdrawn' })
    expect(launchTab()).toBeDefined()
    expect(applyClosedTerminalLeafNotice).toHaveBeenCalledWith(tabId, LEAF)
  })

  it('never touches a pane no launch laid out', () => {
    apply({ kind: 'withdrawn' }, '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')
    expect(launchTab()).toBeDefined()
  })
})

describe('the user closing a launch tab', () => {
  it('is remembered while its agent is starting, so a reveal that raced the close stops it', () => {
    store.getState().closeTab(tabId)
    expect(wasAgentLaunchPaneClosedByUser(tabId, LEAF)).toBe(true)
  })

  it('is not, for a tab whose launch already has its outcome', () => {
    apply({ kind: 'unconfirmed' })
    store.getState().closeTab(tabId)
    expect(wasAgentLaunchPaneClosedByUser(tabId, LEAF)).toBe(false)
  })
})
