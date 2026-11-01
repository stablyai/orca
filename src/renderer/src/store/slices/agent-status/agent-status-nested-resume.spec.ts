import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../store-test-helpers'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'
import { getAgentResumeArgv } from '../../../../../shared/agent-resume-argv'

export function registerAgentStatusNestedResumeTests(): void {
  const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

  afterEach(() => vi.useRealTimers())

  describe('nested provider resume ownership', () => {
    it('captures Claude resume after nested Codex status and session metadata arrive', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          PANE,
          { state: 'working', prompt: 'Parent work', agentType: 'claude' },
          'Claude',
          undefined,
          { worktreeId: 'wt-1', tabId: 'tab-1' },
          { providerSession: { key: 'session_id', id: 'claude-parent' } }
        )
      for (const state of ['working', 'waiting', 'done'] as const) {
        store
          .getState()
          .setAgentStatus(
            PANE,
            { state, prompt: 'Nested review', agentType: 'codex' },
            'Codex',
            undefined,
            { worktreeId: 'wt-1', tabId: 'tab-1' },
            { providerSession: { key: 'session_id', id: 'nested-codex' } }
          )
        const record = sleepingRecordFromEntry({
          state: store.getState(),
          entry: store.getState().agentStatusByPaneKey[PANE],
          worktreeId: 'wt-1',
          capturedAt: Date.now()
        })
        expect(record).toMatchObject({
          agent: 'claude',
          providerSession: { id: 'claude-parent' }
        })
        if (!record) {
          throw new Error('Expected Claude resume record')
        }
        expect(getAgentResumeArgv(record.agent, record.providerSession)).toEqual([
          'claude',
          '--resume',
          'claude-parent'
        ])
        expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.agent).not.toBe('codex')
      }
    })
  })
}
