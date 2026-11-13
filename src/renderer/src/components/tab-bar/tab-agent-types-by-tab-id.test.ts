import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import { createTabBarAgentProjectionSelector } from './tab-agent-types-by-tab-id'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const STALE = '33333333-3333-4333-8333-333333333333'
function splitLayout(activeLeafId: string | null): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: A },
      second: { type: 'leaf', leafId: B }
    },
    activeLeafId,
    expandedLeafId: null
  }
}
function entry(paneKey: string, agentType: string): AgentStatusEntry {
  return {
    paneKey,
    agentType,
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: []
  }
}

describe('published tab agent projection', () => {
  it('follows the active split pane without borrowing a removed sibling', () => {
    const store = createTestStore()
    const select = createTabBarAgentProjectionSelector()
    store.setState({
      agentStatusByPaneKey: acceptedAgentStatuses([
        [`tab:${A}`, entry(`tab:${A}`, 'claude')],
        [`tab:${B}`, entry(`tab:${B}`, 'codex')]
      ]),
      terminalLayoutsByTabId: { tab: splitLayout(A) }
    })
    expect(select(store.getState()).tabAgentTypesByTabId).toEqual({ tab: 'claude' })
    expect(select(store.getState()).nativeChatTabWideFallbackUnsafeTabsById).toEqual({ tab: true })
    store.getState().setTabLayout('tab', splitLayout(B))
    expect(select(store.getState()).tabAgentTypesByTabId).toEqual({ tab: 'codex' })
    store.getState().setTabLayout('tab', splitLayout(STALE))
    expect(select(store.getState()).tabAgentTypesByTabId).toEqual({})
    store.getState().removeAgentStatus(`tab:${A}`)
    store.getState().setTabLayout('tab', {
      root: { type: 'leaf', leafId: B },
      activeLeafId: B,
      expandedLeafId: null
    })
    expect(select(store.getState()).tabAgentTypesByTabId).toEqual({ tab: 'codex' })
    expect(select(store.getState()).nativeChatTabWideFallbackUnsafeTabsById).toEqual({})
    store.getState().removeAgentStatus(`tab:${B}`)
    store.getState().setTabLayout('tab', null)
    expect(select(store.getState()).tabAgentTypesByTabId).toEqual({})
    expect(select(store.getState()).nativeChatTabWideFallbackUnsafeTabsById).toEqual({})
  })

  it('publishes and retires unsafe split routing even without agent rows', () => {
    const store = createTestStore()
    const select = createTabBarAgentProjectionSelector()
    store.getState().setTabLayout('empty', splitLayout(A))
    expect(select(store.getState()).tabAgentTypesByTabId).toEqual({})
    expect(select(store.getState()).nativeChatTabWideFallbackUnsafeTabsById).toEqual({
      empty: true
    })
    store.getState().setTabLayout('empty', null)
    expect(select(store.getState()).nativeChatTabWideFallbackUnsafeTabsById).toEqual({})
  })
})
