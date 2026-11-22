import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import { createTestStore } from '../../../testing/app-store-test-fixture'

export function registerAgentStatusToolAssistantFieldsTests(): void {
  describe('agent status tool + assistant fields', () => {
    // Fake timers prevent queueMicrotask’s real 30-minute freshness handles keeping Vitest alive.
    afterEach(() => {
      vi.useRealTimers()
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

      expect(store.getState().agentStatusByPaneKey.get('tab-1:1')).toMatchObject({
        state: 'done',
        prompt: 'live claude turn',
        agentType: 'claude'
      })
      expect(
        store.getState().agentStatusByPaneKey.get('tab-1:1')!.restoredUnconfirmed
      ).toBeUndefined()
    })
  })
}
