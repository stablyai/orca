import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeAgentStatusEntry,
  makeState
} from '@/runtime/sync-runtime-graph/testing/sync-runtime-graph-test-harness'

import { createAgentNeedsInputSelector } from './agent-needs-input-selector'

const NOW = 1_700_000_000_000

describe('createAgentNeedsInputSelector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is true only while a live agent is blocked or waiting', () => {
    const select = createAgentNeedsInputSelector()
    const stateFor = (state: 'blocked' | 'waiting' | 'working' | 'done', epoch: number) => {
      const entry = makeAgentStatusEntry({ state, updatedAt: NOW })
      return makeState({
        agentStatusByPaneKey: { [entry.paneKey]: entry },
        agentStatusEpoch: epoch
      })
    }

    expect(select(stateFor('blocked', 1))).toBe(true)
    expect(select(stateFor('waiting', 2))).toBe(true)
    expect(select(stateFor('working', 3))).toBe(false)
    expect(select(stateFor('done', 4))).toBe(false)
  })
})
