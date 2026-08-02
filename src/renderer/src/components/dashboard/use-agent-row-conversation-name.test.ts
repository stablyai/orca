import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAgentRowConversationName } from './use-agent-row-conversation-name'
import type { DashboardAgentRow } from './useDashboardData'

const storeState = vi.hoisted(() => ({
  current: { settings: {}, tabsByWorktree: {} } as {
    settings: Record<string, unknown>
    tabsByWorktree: Record<string, unknown[]>
  }
}))

// Why: the mocked selector makes the hook a pure function, so tests can call it
// directly without mounting a component.
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: AppState) => unknown) =>
    selector(storeState.current as unknown as AppState)
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
