import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTestStore } from '../../testing/app-store-test-fixture'

import type { AgentStatusObservation } from '../../../../../shared/agent-status/contracts/agent-status-observation'

import '@/components/sidebar/workspace-card/activity/worktree-card-agent-summary'

{
  describe('agent status runtime orchestration metadata', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('keeps current payload orchestration ahead of a stale runtime map entry', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

      store.getState().setRuntimeAgentOrchestrationByPaneKey({
        [childPaneKey]: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          parentTerminalHandle: 'term-stale'
        }
      })
      store.getState().setAgentStatus(childPaneKey, {
        state: 'working',
        prompt: 'child agent',
        agentType: 'codex',
        orchestration: {
          taskId: 'task-2',
          dispatchId: 'ctx-2',
          parentTerminalHandle: 'term-current'
        }
      })

      expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
        taskId: 'task-2',
        dispatchId: 'ctx-2',
        parentTerminalHandle: 'term-current'
      })
    })

    it('clears stale live orchestration when a reused pane starts non-orchestrated work', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

      store.getState().setAgentStatus(childPaneKey, {
        state: 'done',
        prompt: 'finished child',
        agentType: 'codex',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          parentTerminalHandle: 'term-parent'
        }
      })
      store.getState().setRuntimeAgentOrchestrationByPaneKey({})
      store.getState().setAgentStatus(childPaneKey, {
        state: 'working',
        prompt: 'manual follow-up',
        agentType: 'codex'
      })

      expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toBeUndefined()
    })
  })
}

{
  // Observation-stamped and unstamped rows must remain indistinguishable to existing consumers (STA-4293 step 1).

  const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
  const OBSERVATION: AgentStatusObservation = {
    origin: 'hook',
    authorityId: 'main-agent-hooks:test',
    incarnation: 3,
    revision: 17,
    observedAt: 1_700_000_000_000,
    boundary: true,
    kind: 'transition'
  }

  describe('agent status observation is behavior-neutral', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not carry a previous observation onto an unstamped write', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus(PANE_KEY, {
        state: 'working',
        prompt: 'p',
        agentType: 'claude',
        observation: OBSERVATION
      })
      store.getState().setAgentStatus(PANE_KEY, { state: 'done', prompt: 'p', agentType: 'claude' })

      // Why: inheriting it would let a stale authority claim ordering over a row it never observed.
      expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.observation).toBeUndefined()
    })
  })
}
