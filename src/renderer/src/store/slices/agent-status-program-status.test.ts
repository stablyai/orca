import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProgramStatusFacet } from '../../../../shared/program-status/facet'
import { createTestStore } from './store-test-helpers'

const PANE = 'tab-1:1'
const FACET: ProgramStatusFacet = { state: 'working', progress: 42, observedAt: 1_000 }

describe('agent status program-status facet', () => {
  // Why: setAgentStatus schedules a real freshness timer; fake timers keep it from leaking.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores a main publish facet and clears it when a later main publish sends null', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'p', programStatus: FACET }, undefined, {
        updatedAt: 10
      })
    expect(store.getState().agentStatusByPaneKey[PANE].programStatus).toEqual(FACET)

    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'p', programStatus: null }, undefined, {
        updatedAt: 11
      })
    expect(store.getState().agentStatusByPaneKey[PANE]).not.toHaveProperty('programStatus')
  })

  it('keeps the facet across a writer with no facet channel', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'p', programStatus: FACET }, undefined, {
        updatedAt: 10
      })
    store.getState().setAgentStatus(PANE, { state: 'done', prompt: 'p' }, undefined, {
      updatedAt: 11
    })
    expect(store.getState().agentStatusByPaneKey[PANE].programStatus).toEqual(FACET)
  })

  it('patches only the facet: no timing, history, sequence or epoch change', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(PANE, { state: 'working', prompt: 'p' }, undefined, {
      updatedAt: 10,
      stateStartedAt: 5
    })
    const before = store.getState()
    const entryBefore = before.agentStatusByPaneKey[PANE]

    expect(store.getState().setAgentProgramStatus(PANE, FACET)).toBe(true)

    const after = store.getState()
    const entryAfter = after.agentStatusByPaneKey[PANE]
    expect(entryAfter).toEqual({ ...entryBefore, programStatus: FACET })
    expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
    expect(after.sortEpoch).toBe(before.sortEpoch)
    expect(after.unreadAgentCompletionPanes).toBe(before.unreadAgentCompletionPanes)

    expect(store.getState().setAgentProgramStatus(PANE, null)).toBe(true)
    expect(store.getState().agentStatusByPaneKey[PANE]).toEqual(entryBefore)
  })

  it('ignores an equal facet and never creates a row', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    expect(store.getState().setAgentProgramStatus(PANE, FACET)).toBe(false)
    expect(store.getState().agentStatusByPaneKey[PANE]).toBeUndefined()

    store.getState().setAgentStatus(PANE, { state: 'working', prompt: 'p', programStatus: FACET })
    const map = store.getState().agentStatusByPaneKey
    expect(store.getState().setAgentProgramStatus(PANE, { ...FACET, observedAt: 2_000 })).toBe(
      false
    )
    expect(store.getState().agentStatusByPaneKey).toBe(map)
  })

  it('applies a facet patch inside a batch and reports whether it changed anything', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(PANE, { state: 'working', prompt: 'p' })
    const outcomes = store.getState().setAgentStatuses([
      { kind: 'programStatus', paneKey: PANE, programStatus: FACET },
      { kind: 'programStatus', paneKey: PANE, programStatus: FACET }
    ])
    expect(outcomes).toEqual([true, false])
    expect(store.getState().agentStatusByPaneKey[PANE].programStatus).toEqual(FACET)
  })
})
