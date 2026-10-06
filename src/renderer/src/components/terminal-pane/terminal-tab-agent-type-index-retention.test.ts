import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { selectLiveTabAgentPanes } from '../../lib/tab-agent-status-index'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { createTabBarAgentProjectionSelector } from '../tab-bar/tab-agent-types-by-tab-id'
import { createTerminalTabAgentTypeSelector } from './terminal-tab-agent-type-index'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function collectRetiredSources(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

describe('terminal tab agent type source lifetime', () => {
  it('releases dropped status content after the last pane unsubscribes', async () => {
    const store = createTestStore()
    const select = createTerminalTabAgentTypeSelector()
    const selectTabBar = createTabBarAgentProjectionSelector()

    function parkAndDropStatus(): WeakRef<Record<string, AgentStatusEntry>> {
      const statuses: Record<string, AgentStatusEntry> = {
        'tab-1:leaf-a': {
          state: 'waiting',
          prompt: 'Waiting for an answer',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          paneKey: 'tab-1:leaf-a',
          stateHistory: [],
          agentType: 'claude',
          interactivePrompt: JSON.stringify({ question: 'Choose the next step' })
        }
      }
      store.setState({ agentStatusByPaneKey: statuses })
      expect(select(statuses, 'tab-1')).toEqual({ 'leaf-a': 'claude' })
      const unsubscribe = store.subscribe((state) => {
        select(state.agentStatusByPaneKey, 'tab-1')
      })
      selectLiveTabAgentPanes(statuses, 'tab-1')
      selectTabBar({ agentStatusByPaneKey: statuses, settings: { experimentalNativeChat: true } })

      // Parking removes pane subscribers while the retained tab strip still observes removals.
      unsubscribe()
      store.getState().dropAgentStatus('tab-1:leaf-a')
      const current = store.getState().agentStatusByPaneKey
      expect(current).toEqual({})
      selectLiveTabAgentPanes(current, 'tab-1')
      selectTabBar({ agentStatusByPaneKey: current, settings: { experimentalNativeChat: true } })
      return new WeakRef(statuses)
    }

    const retired = parkAndDropStatus()
    await collectRetiredSources()

    expect(retired.deref()).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey).toEqual({})
    expect(select(store.getState().agentStatusByPaneKey, 'tab-1')).toEqual({})
  })

  it('releases the foreground source after the last pane unsubscribes', async () => {
    const store = createTestStore()
    const select = createTerminalTabAgentTypeSelector()

    function parkAndClearForeground() {
      store.getState().setPaneForegroundAgent('tab-1:leaf-a', {
        agent: 'codex',
        shellForeground: false,
        routingTrusted: true
      })
      const foreground = store.getState().paneForegroundAgentByPaneKey
      expect(select({}, 'tab-1', foreground)).toEqual({ 'leaf-a': 'codex' })
      store.getState().clearPaneForegroundAgent('tab-1:leaf-a')
      return new WeakRef(foreground)
    }

    const retired = parkAndClearForeground()
    await collectRetiredSources()

    expect(retired.deref()).toBeUndefined()
    expect(select({}, 'tab-1', store.getState().paneForegroundAgentByPaneKey)).toEqual({})
  })
})
