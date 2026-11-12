import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AppState } from '../../types'
import { createTestStore } from '../../testing/app-store-test-fixture'

export function registerAgentStatusToolAssistantFieldsTests(): void {
  describe('agent status tool + assistant fields', () => {
    // Fake timers prevent queueMicrotask’s real 30-minute freshness handles keeping Vitest alive.
    afterEach(() => {
      vi.useRealTimers()
    })

    it('ignores nested done while the parent pane agent is still active', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      const setGeneratedTabTitleFromAgentPrompt = vi.fn()
      store.setState({
        settings: { ...store.getState().settings, tabAutoGenerateTitle: true },
        setGeneratedTabTitleFromAgentPrompt
      } as Partial<AppState>)
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'parent codex', agentType: 'codex' },
          'codex',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )
      const firstEpoch = store.getState().agentStatusEpoch

      store.getState().setAgentStatus(
        'tab-1:1',
        {
          state: 'done',
          prompt: 'nested claude',
          agentType: 'claude',
          toolName: 'Read',
          toolInput: '00-review-context.md',
          lastAssistantMessage: 'child finished'
        },
        'claude',
        { updatedAt: 1_100, stateStartedAt: 1_100 }
      )

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry).toMatchObject({
        state: 'working',
        prompt: 'parent codex',
        agentType: 'codex',
        updatedAt: 1_000,
        stateStartedAt: 1_000
      })
      expect(entry.toolName).toBeUndefined()
      expect(entry.toolInput).toBeUndefined()
      expect(entry.lastAssistantMessage).toBeUndefined()
      expect(store.getState().agentStatusEpoch).toBe(firstEpoch)
      expect(setGeneratedTabTitleFromAgentPrompt).toHaveBeenCalledTimes(1)
      expect(setGeneratedTabTitleFromAgentPrompt).toHaveBeenLastCalledWith(
        'tab-1:1',
        'parent codex'
      )
    })

    it('does not let restored-unconfirmed identity suppress a live terminal status', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus(
        'tab-1:1',
        {
          state: 'working',
          prompt: 'stale codex turn',
          agentType: 'codex',
          restoredUnconfirmed: true
        },
        'codex',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )

      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'done', prompt: 'live claude turn', agentType: 'claude' },
          'claude',
          { updatedAt: 1_100, stateStartedAt: 1_100 }
        )

      expect(store.getState().agentStatusByPaneKey['tab-1:1']).toMatchObject({
        state: 'done',
        prompt: 'live claude turn',
        agentType: 'claude'
      })
      expect(store.getState().agentStatusByPaneKey['tab-1:1'].restoredUnconfirmed).toBeUndefined()
    })
  })
}
