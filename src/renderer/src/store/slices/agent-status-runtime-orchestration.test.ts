import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore, makeTab } from './store-test-helpers'

describe('agent status runtime orchestration metadata', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fills runtime orchestration metadata into existing live entries', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex'
    })
    const epochBeforeRuntime = store.getState().agentStatusEpoch
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Checkout race',
        displayName: 'Fix checkout race',
        parentPaneKey
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      taskTitle: 'Checkout race',
      displayName: 'Fix checkout race',
      parentPaneKey
    })
    expect(store.getState().agentStatusEpoch).toBe(epochBeforeRuntime + 1)
  })

  it('replaces stale live orchestration metadata when runtime dispatch identity changes', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const staleParentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'
    const currentParentPaneKey = 'tab-parent:33333333-3333-4333-8333-333333333333'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey: staleParentPaneKey,
        parentTerminalHandle: 'term-stale'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-2',
        dispatchId: 'ctx-2',
        parentPaneKey: currentParentPaneKey,
        parentTerminalHandle: 'term-current'
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-2',
      dispatchId: 'ctx-2',
      parentPaneKey: currentParentPaneKey,
      parentTerminalHandle: 'term-current'
    })
  })

  it('uses existing orchestration fields only as fallback for the same runtime dispatch', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey,
        coordinatorHandle: 'term-stale-coordinator'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        coordinatorHandle: 'term-current-coordinator'
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentPaneKey,
      coordinatorHandle: 'term-current-coordinator'
    })
  })

  it('clears stale lineage when the authoritative runtime snapshot loses its Run binding', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        dispatchStatus: 'dispatched',
        parentTerminalHandle: 'term-old-coordinator',
        parentPaneKey: 'tab-parent:22222222-2222-4222-8222-222222222222',
        coordinatorHandle: 'term-old-coordinator',
        orchestrationRunId: 'run-1'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        dispatchStatus: 'dispatched',
        orchestrationRunId: 'run-1'
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      dispatchStatus: 'dispatched',
      orchestrationRunId: 'run-1'
    })
  })

  it('updates runtime status for the same dispatch', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'done',
      prompt: 'child agent',
      agentType: 'claude',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        dispatchStatus: 'dispatched'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        dispatchStatus: 'completed'
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      dispatchStatus: 'completed'
    })
  })

  it.each(['failed', 'circuit_broken'] as const)(
    'updates runtime status to %s for the same dispatch',
    (dispatchStatus) => {
      vi.useFakeTimers()
      const store = createTestStore()
      const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

      store.getState().setAgentStatus(childPaneKey, {
        state: 'done',
        prompt: 'child agent',
        agentType: 'claude',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          dispatchStatus: 'dispatched'
        }
      })
      store.getState().setRuntimeAgentOrchestrationByPaneKey({
        [childPaneKey]: { taskId: 'task-1', dispatchId: 'ctx-1', dispatchStatus }
      })

      expect(
        store.getState().agentStatusByPaneKey[childPaneKey].orchestration?.dispatchStatus
      ).toBe(dispatchStatus)
    }
  )

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

  it('fills already-synced runtime orchestration metadata into new live entries', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'

    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey
      }
    })
    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex'
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentPaneKey
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

  it('preserves stale live orchestration for final done rows', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentTerminalHandle: 'term-parent'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({})
    store.getState().setAgentStatus(childPaneKey, {
      state: 'done',
      prompt: 'child finished',
      agentType: 'codex'
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentTerminalHandle: 'term-parent'
    })
  })

  it('fills runtime orchestration metadata into retained entries', () => {
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'
    const now = Date.now()
    const entry: AgentStatusEntry = {
      state: 'done',
      prompt: 'child agent',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: childPaneKey,
      stateHistory: []
    }
    const retained: RetainedAgentEntry = {
      entry,
      worktreeId: 'wt-1',
      tab: makeTab({ id: 'tab-child', worktreeId: 'wt-1', title: 'codex' }),
      agentType: 'codex',
      startedAt: now
    }

    store.getState().retainAgents([retained])
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey
      }
    })

    expect(
      store.getState().retainedAgentsByPaneKey[childPaneKey].entry.orchestration
    ).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentPaneKey
    })
  })
})
