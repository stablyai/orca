import { describe, expect, it } from 'vitest'
import {
  isNativeChatReasoningUnderway,
  isNativeChatSubagentThinking,
  nativeChatReasoningGate,
  nativeChatReasoningGateKey,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText
} from './native-chat-reasoning-row'

const reasoningOpen = (
  activity: Parameters<typeof nativeChatReasoningGateKey>[0],
  liveTurnId: string | null,
  agentId?: string
) => nativeChatReasoningGate(nativeChatReasoningGateKey(activity, liveTurnId))(agentId)

describe('the live reasoning gate', () => {
  const open = { turnId: 'turn-1', text: '', reasoning: { session: true, subagents: ['task-1'] } }

  it("answers per scope: the session's own agent, or one subagent by its id", () => {
    expect(reasoningOpen(open, 'turn-1')).toBe(true)
    expect(reasoningOpen(open, 'turn-1', 'task-1')).toBe(true)
    expect(reasoningOpen(open, 'turn-1', 'task-2')).toBe(false)
    const childOnly = { ...open, reasoning: { session: false, subagents: ['task-1'] } }
    expect(reasoningOpen(childOnly, 'turn-1')).toBe(false)
  })

  it('reads reasoning that lists no subagents as only what it says about the session', () => {
    // A peer may omit the list; the reducer's equality tolerates that the same way.
    const partial = JSON.parse('{"turnId":"turn-1","text":"","reasoning":{"session":true}}')
    expect(reasoningOpen(partial, 'turn-1')).toBe(true)
    expect(reasoningOpen(partial, 'turn-1', 'task-1')).toBe(false)
  })

  it('reports nothing for another turn, no live turn, or a host that sends no signal', () => {
    expect(reasoningOpen(open, 'turn-2')).toBe(false)
    expect(reasoningOpen(open, null)).toBe(false)
    expect(reasoningOpen({ turnId: 'turn-1', text: 'Running a command' }, 'turn-1')).toBe(false)
    expect(reasoningOpen(null, 'turn-1')).toBe(false)
  })
})

describe("the gate's key", () => {
  const open = { turnId: 'turn-1', text: '', reasoning: { session: true, subagents: ['task-1'] } }

  it('changes only when an answer does, never with the words', () => {
    const key = nativeChatReasoningGateKey(open, 'turn-1')
    expect(nativeChatReasoningGateKey({ ...open, text: 'Running a command' }, 'turn-1')).toBe(key)
    expect(
      nativeChatReasoningGateKey({ ...open, reasoning: { session: true, subagents: [] } }, 'turn-1')
    ).not.toBe(key)
    expect(nativeChatReasoningGateKey(open, 'turn-2')).toBe('')
  })

  it('keeps ids apart whatever characters they hold', () => {
    const key = (subagents: string[]) =>
      nativeChatReasoningGateKey({ ...open, reasoning: { session: false, subagents } }, 'turn-1')
    expect(key(['a\nb'])).not.toBe(key(['a', 'b']))
    expect(key(['b', 'a'])).toBe(key(['a', 'b']))
    const gate = nativeChatReasoningGate(key(['a\nb']))
    expect([gate('a\nb'), gate('a'), gate('b'), gate()]).toEqual([true, false, false, false])
  })

  it('answers through the gate it keys exactly as the gate does', () => {
    for (const reasoning of [
      { session: true, subagents: [] },
      { session: false, subagents: ['task-1', 'task-2'] },
      { session: true, subagents: ['task-2'] }
    ]) {
      const gate = nativeChatReasoningGate(
        nativeChatReasoningGateKey({ ...open, reasoning }, 'turn-1')
      )
      for (const agentId of [undefined, 'task-1', 'task-2', 'session', '']) {
        expect(gate(agentId)).toBe(
          agentId === undefined ? reasoning.session : reasoning.subagents.includes(agentId)
        )
      }
    }
  })
})

describe("a subagent's Thinking", () => {
  const open = (agentId?: string) => agentId === 'task-1'

  it('shows only while the host reports its reasoning open and its roster says it works', () => {
    expect(isNativeChatSubagentThinking(open, 'task-1', { state: 'working' })).toBe(true)
    expect(isNativeChatSubagentThinking(open, 'task-1', { state: 'completed' })).toBe(false)
    expect(isNativeChatSubagentThinking(open, 'task-1', undefined)).toBe(false)
    expect(isNativeChatSubagentThinking(open, 'task-2', { state: 'working' })).toBe(false)
  })
})

describe('the reasoning row every client draws', () => {
  it('is hidden only while its block is still being written and the host reports it open', () => {
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'running' }, true)).toBe(true)
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'running' }, false)).toBe(
      false
    )
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'completed' }, true)).toBe(
      false
    )
    expect(isNativeChatReasoningUnderway({ role: 'reasoning' }, true)).toBe(false)
    expect(isNativeChatReasoningUnderway({ role: 'assistant', state: 'running' }, true)).toBe(false)
  })

  it('reads the span the host saw, at least a second, and claims none it did not see', () => {
    const text = (fields: { state?: 'running' | 'completed'; completedAt?: number }) =>
      nativeChatReasoningHeadlineText(nativeChatReasoningHeadline({ timestamp: 1_000, ...fields }))
    expect(text({ state: 'completed', completedAt: 66_000 })).toBe('Thought for 1m 5s')
    expect(text({ state: 'completed', completedAt: 1_300 })).toBe('Thought for 1s')
    expect(text({ state: 'completed' })).toBe('Thought')
    // Not ended yet: nothing past tense.
    expect(text({ state: 'running' })).toBe('Reasoning')
    expect(text({})).toBe('Reasoning')
  })
})
