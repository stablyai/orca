import { describe, expect, it } from 'vitest'
import { resolveNativeChatAgentStateRow } from './native-chat-agent-state-row'

describe('resolveNativeChatAgentStateRow', () => {
  it('reports the agent as waiting on the reader for both stopped states', () => {
    expect(resolveNativeChatAgentStateRow({ isWorking: false, agentState: 'blocked' })).toBe(
      'waiting-for-user'
    )
    expect(resolveNativeChatAgentStateRow({ isWorking: false, agentState: 'waiting' })).toBe(
      'waiting-for-user'
    )
  })

  it('draws nothing for a finished or unknown turn', () => {
    expect(resolveNativeChatAgentStateRow({ isWorking: false, agentState: 'done' })).toBeNull()
    expect(resolveNativeChatAgentStateRow({ isWorking: false, agentState: null })).toBeNull()
    expect(resolveNativeChatAgentStateRow({ isWorking: false })).toBeNull()
  })

  it('keeps the reconciled turn truth as the only working authority', () => {
    expect(resolveNativeChatAgentStateRow({ isWorking: true, agentState: 'working' })).toBe(
      'working'
    )
    // A stale 'working' row cannot revive a turn the merge already settled.
    expect(resolveNativeChatAgentStateRow({ isWorking: false, agentState: 'working' })).toBeNull()
    // …nor can a lagging 'blocked' row outrank a turn that is demonstrably live.
    expect(resolveNativeChatAgentStateRow({ isWorking: true, agentState: 'blocked' })).toBe(
      'working'
    )
  })
})
