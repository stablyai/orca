// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AGENT_MAP_TIME_MAX_INDEX } from './agent-map-time-filter'
import { useAgentMapFilters } from './useAgentMapFilters'

describe('useAgentMapFilters', () => {
  it('resets states without clearing the other map filters', () => {
    const hook = renderHook(() => useAgentMapFilters(['claude', 'codex']))

    act(() => hook.result.current.applyQuickView('stuck'))
    act(() => hook.result.current.resetStates())

    expect([...hook.result.current.states]).toEqual(['attention', 'working', 'done', 'idle'])
    expect(hook.result.current.timeRanges.sinceMessage).toEqual({
      min: 4,
      max: AGENT_MAP_TIME_MAX_INDEX
    })
    expect(hook.result.current.activeCount).toBe(1)
  })

  it('preserves a muted agent type across disappearance and reappearance', () => {
    let agentTypes = ['claude', 'codex']
    const hook = renderHook(() => useAgentMapFilters(agentTypes))

    act(() => hook.result.current.toggleAgentType('claude'))
    agentTypes = ['codex']
    hook.rerender()

    expect([...hook.result.current.agentTypes]).toEqual(['codex'])
    expect(hook.result.current.activeCount).toBe(0)

    agentTypes = ['claude', 'codex']
    hook.rerender()

    expect([...hook.result.current.agentTypes]).toEqual(['codex'])
    expect(hook.result.current.activeCount).toBe(1)
  })

  it('enables a newly discovered agent type', () => {
    let agentTypes = ['claude']
    const hook = renderHook(() => useAgentMapFilters(agentTypes))

    agentTypes = ['claude', 'grok']
    hook.rerender()

    expect([...hook.result.current.agentTypes]).toEqual(['claude', 'grok'])
  })
})
