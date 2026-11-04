import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusEntry,
  AgentStatusState
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'

import { createTestStore } from '../store-test-helpers'
import { makeTab } from '../store-session-test-harness'
import type { AgentStatusObservation } from '../../../../../shared/agent-status/contracts/agent-status-observation'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { buildWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-rows'
import '@/components/sidebar/workspace-card/activity/worktree-card-agent-summary'
import { agentRowDisplayDotState as getAgentDotState } from '@/lib/agent-row-dot-state'
import { resolveAttention } from '../../../../../shared/sidebar-list/smart-attention'

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

  const STATES: AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']

  function withoutObservation(entry: AgentStatusEntry): Omit<AgentStatusEntry, 'observation'> {
    const { observation: _observation, ...rest } = entry
    return rest
  }

  function applyStatus(
    state: AgentStatusState,
    observation: AgentStatusObservation | undefined
  ): {
    entry: AgentStatusEntry
    agentStatusEpoch: number
    sortEpoch: number
  } {
    const store = createTestStore()
    store.getState().setAgentStatus(PANE_KEY, {
      state: 'working',
      prompt: 'first turn',
      agentType: 'claude',
      ...(observation ? { observation } : {})
    })
    store.getState().setAgentStatus(PANE_KEY, {
      state,
      prompt: 'first turn',
      agentType: 'claude',
      lastAssistantMessage: state === 'done' ? 'all set' : undefined,
      ...(observation ? { observation } : {})
    })
    const snapshot = store.getState()
    const entry = snapshot.agentStatusByPaneKey[PANE_KEY]
    if (!entry) {
      throw new Error(`expected a live entry for ${state}`)
    }
    return {
      entry,
      agentStatusEpoch: snapshot.agentStatusEpoch,
      sortEpoch: snapshot.sortEpoch
    }
  }

  describe('agent status observation is behavior-neutral', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it.each(STATES)('resolves %s identically for freshness, rows, dot and attention', (state) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_700_000_000_000)
      const stamped = applyStatus(state, OBSERVATION).entry
      vi.setSystemTime(1_700_000_000_000)
      const unstamped = applyStatus(state, undefined).entry
      vi.useRealTimers()

      const now = 1_700_000_000_000
      const tabs = [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]

      for (const at of [now, now + AGENT_STATUS_STALE_AFTER_MS + 1]) {
        expect(isExplicitAgentStatusFresh(stamped, at, AGENT_STATUS_STALE_AFTER_MS)).toBe(
          isExplicitAgentStatusFresh(unstamped, at, AGENT_STATUS_STALE_AFTER_MS)
        )

        const stampedRows = buildWorktreeAgentRows({
          tabs,
          entries: [stamped],
          retained: [],
          now: at
        })
        const unstampedRows = buildWorktreeAgentRows({
          tabs,
          entries: [unstamped],
          retained: [],
          now: at
        })
        // Why: an empty-vs-empty comparison would pass without proving anything.
        expect(stampedRows).toHaveLength(1)
        expect(
          stampedRows.map((row) => ({ ...row, entry: withoutObservation(row.entry) }))
        ).toEqual(unstampedRows.map((row) => ({ ...row, entry: withoutObservation(row.entry) })))
        expect(stampedRows.map(getAgentDotState)).toEqual(unstampedRows.map(getAgentDotState))

        expect(resolveAttention([{ kind: 'hook', entry: stamped, hasLivePty: false }], at)).toEqual(
          resolveAttention([{ kind: 'hook', entry: unstamped, hasLivePty: false }], at)
        )
      }
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
