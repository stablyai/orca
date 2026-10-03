// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

const WORKTREE = 'repo::/wt-ack'
const PANE_KEY = makePaneKey('tab-ack', '11111111-1111-4111-8111-111111111111')
const initial = useAppStore.getState()

afterEach(() => {
  act(() => useAppStore.setState(initial, true))
})

describe('useWorktreeAgentRows', () => {
  // Joined where the rows are built, so the card, its summary and the notes send menu read one
  // seen-ness and keep each row object while nothing about it changes.
  it("carries each row's acknowledgement on its entry", () => {
    const now = Date.now()
    const entry: AgentStatusEntry = {
      paneKey: PANE_KEY,
      state: 'done',
      prompt: 'Run the tests',
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: [],
      agentType: 'claude',
      mainAgent: { state: 'done', outcome: 'interruption', stateStartedAt: now }
    }
    act(() =>
      useAppStore.setState({
        tabsByWorktree: {
          [WORKTREE]: [
            {
              id: 'tab-ack',
              ptyId: null,
              worktreeId: WORKTREE,
              title: 'Claude',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        agentStatusByPaneKey: { [PANE_KEY]: entry },
        acknowledgedAgentsByPaneKey: {}
      })
    )
    const { result } = renderHook(() => useWorktreeAgentRows(WORKTREE))
    const unseen = result.current[0]
    expect(unseen?.entry.acknowledgedAt).toBe(0)

    act(() => useAppStore.setState({ acknowledgedAgentsByPaneKey: { [PANE_KEY]: now } }))
    const seen = result.current[0]
    expect(seen?.entry.acknowledgedAt).toBe(now)
    expect(seen).not.toBe(unseen)

    act(() => useAppStore.setState({ acknowledgedAgentsByPaneKey: { [PANE_KEY]: now, other: 1 } }))
    expect(result.current[0]).toBe(seen)
  })
})
