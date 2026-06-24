import { create } from 'zustand'
import { describe, expect, it } from 'vitest'
import { createOrchestrationRunDagSlice } from './orchestration-run-dag'
import type { OrchestrationRunDag, OrchestrationTaskNode } from '../../../../shared/runtime-types'
import type { AppState } from '../types'

function taskNode(overrides: Partial<OrchestrationTaskNode>): OrchestrationTaskNode {
  return {
    id: 'task_1',
    status: 'dispatched',
    deps: [],
    title: 'Task 1',
    targetKey: null,
    dispatch: {
      assigneeHandle: 'term_x',
      assigneeAgent: 'codex',
      status: 'dispatched',
      lastHeartbeatAt: '2026-06-01T00:00:00.000Z',
      stale: false
    },
    signal: { phase: 'implementing', summary: null },
    ...overrides
  }
}

function dag(tasks: OrchestrationTaskNode[]): OrchestrationRunDag {
  return { runId: 'run_1', recipe: null, tasks, truncatedTaskCount: 0 }
}

function createStore() {
  return create<AppState>()((...a) => ({ ...createOrchestrationRunDagSlice(...a) }) as AppState)
}

describe('orchestration-run-dag slice', () => {
  it('keeps the same reference when content is structurally equal (no re-render churn)', () => {
    const store = createStore()
    store.getState().setOrchestrationRunDagByPaneKey({ 'tab:leaf': dag([taskNode({})]) })
    const first = store.getState().orchestrationRunDagByPaneKey

    // A fresh-but-equal payload (new object identity, same values) must not swap
    // the map reference.
    store.getState().setOrchestrationRunDagByPaneKey({ 'tab:leaf': dag([taskNode({})]) })
    expect(store.getState().orchestrationRunDagByPaneKey).toBe(first)
  })

  it('replaces the reference when a task changes', () => {
    const store = createStore()
    store.getState().setOrchestrationRunDagByPaneKey({ 'tab:leaf': dag([taskNode({})]) })
    const first = store.getState().orchestrationRunDagByPaneKey

    store
      .getState()
      .setOrchestrationRunDagByPaneKey({ 'tab:leaf': dag([taskNode({ status: 'completed' })]) })
    expect(store.getState().orchestrationRunDagByPaneKey).not.toBe(first)
    expect(store.getState().orchestrationRunDagByPaneKey['tab:leaf']?.tasks[0]?.status).toBe(
      'completed'
    )
  })

  it('replaces the reference when a dispatch becomes stale', () => {
    const store = createStore()
    store.getState().setOrchestrationRunDagByPaneKey({ 'tab:leaf': dag([taskNode({})]) })
    const first = store.getState().orchestrationRunDagByPaneKey

    const stale = taskNode({
      dispatch: { ...taskNode({}).dispatch!, stale: true }
    })
    store.getState().setOrchestrationRunDagByPaneKey({ 'tab:leaf': dag([stale]) })
    expect(store.getState().orchestrationRunDagByPaneKey).not.toBe(first)
  })
})
