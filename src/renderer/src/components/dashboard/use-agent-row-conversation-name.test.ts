import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAgentRowConversationName } from './use-agent-row-conversation-name'
import type { DashboardAgentRow } from './useDashboardData'

const storeState = vi.hoisted(() => ({
  current: { settings: {}, tabsByWorktree: {} } as {
    settings: Record<string, unknown>
    tabsByWorktree: Record<string, unknown[]>
    terminalLayoutsByTabId?: Record<string, unknown>
    runtimePaneTitlesByTabId?: Record<string, unknown>
  }
}))

// Why: the mocked selector makes the hook a pure function, so tests can call it
// directly without mounting a component. The pane maps default to empty so each
// test declares only the ones it exercises.
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: AppState) => unknown) =>
    selector({
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      ...storeState.current
    } as unknown as AppState)
}))

function makeAgent(overrides: Partial<DashboardAgentRow> = {}): DashboardAgentRow {
  return {
    paneKey: 'tab-1:leaf-1',
    entry: { prompt: 'fix the sidebar' },
    tab: { id: 'tab-1', worktreeId: 'wt-1', customTitle: 'Patient sync spike', title: '' },
    agentType: 'claude',
    state: 'working',
    startedAt: 0,
    ...overrides
  } as DashboardAgentRow
}

beforeEach(() => {
  storeState.current = { settings: {}, tabsByWorktree: {} }
})

describe('useAgentRowConversationName', () => {
  it('returns the conversation name by default', () => {
    expect(useAgentRowConversationName(makeAgent())).toBe('Patient sync spike')
  })

  it('ignores a retired stored opt-out value', () => {
    storeState.current = { settings: { agentRowsUseConversationName: false }, tabsByWorktree: {} }
    expect(useAgentRowConversationName(makeAgent())).toBe('Patient sync spike')
  })

  it('never reads the parent tab for subagent child rows', () => {
    const tabsByWorktree = new Proxy(
      {},
      {
        get: () => {
          throw new Error('subagent rows must not read the parent tab')
        }
      }
    )
    storeState.current = { settings: {}, tabsByWorktree }
    expect(useAgentRowConversationName(makeAgent({ rowSource: 'subagent' }))).toBeNull()
  })

  it('does not inherit a same-tab lineage parent conversation name', () => {
    const tabsByWorktree = new Proxy(
      {},
      {
        get: () => {
          throw new Error('same-tab child rows must not read the parent tab')
        }
      }
    )
    storeState.current = { settings: {}, tabsByWorktree }
    expect(
      useAgentRowConversationName(
        makeAgent({
          entry: {
            prompt: 'child prompt',
            orchestration: {
              parentPaneKey: 'tab-1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            }
          },
          lineage: { depth: 1, isFirstSibling: true, isLastSibling: true, childCount: 0 }
        } as Partial<DashboardAgentRow>)
      )
    ).toBeNull()
  })

  it('uses a lineage child conversation name when it owns a separate tab', () => {
    const agent = makeAgent({
      entry: {
        prompt: 'child prompt',
        orchestration: {
          parentPaneKey: 'parent-tab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        }
      },
      lineage: { depth: 1, isFirstSibling: true, isLastSibling: true, childCount: 0 }
    } as Partial<DashboardAgentRow>)
    expect(useAgentRowConversationName(agent)).toBe('Patient sync spike')
  })

  it('indexes one immutable tab array once across rows', () => {
    let tabReads = 0
    const tabs = new Proxy(
      [
        { id: 'tab-1', worktreeId: 'wt-1', customTitle: 'First name', title: '' },
        { id: 'tab-2', worktreeId: 'wt-1', customTitle: 'Second name', title: '' }
      ],
      {
        get: (target, property, receiver) => {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            tabReads += 1
          }
          return Reflect.get(target, property, receiver)
        }
      }
    )
    storeState.current = {
      settings: {},
      tabsByWorktree: { 'wt-1': tabs }
    }

    expect(useAgentRowConversationName(makeAgent())).toBe('First name')
    const readsAfterFirstRow = tabReads
    expect(
      useAgentRowConversationName(
        makeAgent({
          paneKey: 'tab-2:leaf-1',
          tab: { id: 'tab-2', worktreeId: 'wt-1', customTitle: null, title: '' }
        } as Partial<DashboardAgentRow>)
      )
    ).toBe('Second name')
    expect(readsAfterFirstRow).toBeGreaterThan(0)
    expect(tabReads).toBe(readsAfterFirstRow)
  })

  it('prefers the live store tab over the stale row snapshot', () => {
    storeState.current = {
      settings: {},
      // Why: row data patches entries in place and keeps the creation-time tab
      // snapshot; a rename landing after that must still surface.
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', worktreeId: 'wt-1', customTitle: 'Renamed later', title: '' }]
      }
    }
    expect(useAgentRowConversationName(makeAgent())).toBe('Renamed later')
  })

  // STA-2811 / #11069: both panes of a split tab showed one name that flipped to
  // whichever pane was clicked last, because tab.title tracks only the focused pane.
  describe('split panes', () => {
    const LEAF_A = '11111111-1111-4111-8111-111111111111'
    const LEAF_B = '22222222-2222-4222-8222-222222222222'
    const SPLIT_LAYOUT = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B }
      },
      activeLeafId: LEAF_A,
      expandedLeafId: null
    }

    // Why: pty-connection syncs the FOCUSED pane's title onto the tab, so the tab
    // snapshot every row carries names one pane and mislabels the other.
    function splitRow(leafId: string, focusedPaneTitle: string): DashboardAgentRow {
      return makeAgent({
        paneKey: `tab-1:${leafId}`,
        tab: { id: 'tab-1', worktreeId: 'wt-1', customTitle: null, title: focusedPaneTitle }
      } as Partial<DashboardAgentRow>)
    }

    function setSplitStore(focusedPaneTitle: string, customTitle: string | null = null): void {
      storeState.current = {
        settings: {},
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', worktreeId: 'wt-1', customTitle, title: focusedPaneTitle }]
        },
        terminalLayoutsByTabId: { 'tab-1': SPLIT_LAYOUT },
        // Pane ids are replay-creation-ordered: 1 -> LEAF_A, 2 -> LEAF_B.
        runtimePaneTitlesByTabId: {
          'tab-1': { 1: '\u2733 Linear work log', 2: '\u2733 Redis cache strategy' }
        }
      }
    }

    it('gives each pane in one tab its own name', () => {
      setSplitStore('\u2733 Linear work log')
      expect(useAgentRowConversationName(splitRow(LEAF_A, '\u2733 Linear work log'))).toBe(
        'Linear work log'
      )
      expect(useAgentRowConversationName(splitRow(LEAF_B, '\u2733 Linear work log'))).toBe(
        'Redis cache strategy'
      )
    })

    it('does not rename the sibling row when the other pane is clicked', () => {
      // Clicking pane B re-syncs the tab title to B's; both rows must be unmoved.
      setSplitStore('\u2733 Redis cache strategy')
      expect(useAgentRowConversationName(splitRow(LEAF_A, '\u2733 Redis cache strategy'))).toBe(
        'Linear work log'
      )
      expect(useAgentRowConversationName(splitRow(LEAF_B, '\u2733 Redis cache strategy'))).toBe(
        'Redis cache strategy'
      )
    })

    it('lends no name to a split pane with no live title of its own', () => {
      // Why: the tab title here is the SIBLING's, so the row keeps its own label.
      storeState.current = {
        settings: {},
        tabsByWorktree: {
          'wt-1': [
            { id: 'tab-1', worktreeId: 'wt-1', customTitle: null, title: '\u2733 Linear work log' }
          ]
        },
        terminalLayoutsByTabId: { 'tab-1': SPLIT_LAYOUT },
        runtimePaneTitlesByTabId: { 'tab-1': { 1: '\u2733 Linear work log' } }
      }
      expect(useAgentRowConversationName(splitRow(LEAF_B, '\u2733 Linear work log'))).toBeNull()
    })

    it('still lends a tab-owned name to every pane', () => {
      setSplitStore('\u2733 Linear work log', 'Patient sync spike')
      expect(useAgentRowConversationName(splitRow(LEAF_A, '\u2733 Linear work log'))).toBe(
        'Patient sync spike'
      )
      expect(useAgentRowConversationName(splitRow(LEAF_B, '\u2733 Linear work log'))).toBe(
        'Patient sync spike'
      )
    })

    it('leaves a single-leaf tab on its tab title', () => {
      storeState.current = {
        settings: {},
        tabsByWorktree: {
          'wt-1': [
            { id: 'tab-1', worktreeId: 'wt-1', customTitle: null, title: '\u2733 Redis cache' }
          ]
        },
        terminalLayoutsByTabId: {
          'tab-1': { root: { type: 'leaf', leafId: LEAF_A }, activeLeafId: LEAF_A }
        },
        runtimePaneTitlesByTabId: {}
      }
      expect(useAgentRowConversationName(splitRow(LEAF_A, '\u2733 Redis cache'))).toBe(
        'Redis cache'
      )
    })
  })

  it('honors the generated-titles setting for generated names', () => {
    const agent = makeAgent({
      tab: { customTitle: null, title: '', generatedTitle: 'Fix intake flow' }
    } as Partial<DashboardAgentRow>)
    storeState.current = { settings: {}, tabsByWorktree: {} }
    expect(useAgentRowConversationName(agent)).toBeNull()
    storeState.current = {
      settings: { tabAutoGenerateTitle: true },
      tabsByWorktree: {}
    }
    expect(useAgentRowConversationName(agent)).toBe('Fix intake flow')
  })
})
