import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { selectStructuredAgentForkRows } from './structured-agent-session-fork-rows'

function row(itemId: string, body: unknown, extra: Record<string, unknown> = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only a row's id, body, turn scope and producer.
  return { itemId, body, ...extra } as AgentJournalRenderItem
}

const inTurn = (turnItemId: string) => ({ turnScope: { kind: 'turn', turnItemId } })
const said = (text: string) => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})
const turn = (turnId: string, fields: Record<string, unknown>) => ({
  kind: 'turn',
  turnId,
  ...fields
})
const FINISHED = { state: 'completed', outcome: 'success' }

describe('the rows that offer a fork', () => {
  it('offers it once per finished turn, on the last words the agent wrote in it', () => {
    const items = [
      row('turn-a', turn('a', FINISHED)),
      row('a-prompt', { kind: 'message', role: 'user', blocks: [] }, inTurn('turn-a')),
      row('a-first', said('looking'), inTurn('turn-a')),
      row('a-tools', { kind: 'tool-call' }, inTurn('turn-a')),
      row('a-last', said('done'), inTurn('turn-a')),
      row('turn-b', turn('b', FINISHED)),
      row('b-last', said('done again'), inTurn('turn-b'))
    ]

    expect([...selectStructuredAgentForkRows('codex', items)]).toEqual(['a-last', 'b-last'])
  })

  it('skips a row whose text is empty, which draws no controls to hang the action under', () => {
    const items = [
      row('turn-a', turn('a', FINISHED)),
      row('a-answer', said('done'), inTurn('turn-a')),
      row('a-empty', said(''), inTurn('turn-a'))
    ]

    expect([...selectStructuredAgentForkRows('codex', items)]).toEqual(['a-answer'])
  })

  it('offers nothing on a turn that has not finished', () => {
    const items = [
      row('turn-a', turn('a', { state: 'running' })),
      row('a-last', said('working'), inTurn('turn-a'))
    ]

    expect(selectStructuredAgentForkRows('codex', items).size).toBe(0)
  })

  it('skips rows that draw no answer controls: reasoning, and a run of tools with no words', () => {
    const items = [
      row('turn-a', turn('a', FINISHED)),
      row('a-answer', said('done'), inTurn('turn-a')),
      row(
        'a-thought',
        { kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text: 'hm' }] },
        inTurn('turn-a')
      ),
      row(
        'a-tools',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'tool-call' }] },
        inTurn('turn-a')
      )
    ]

    expect([...selectStructuredAgentForkRows('codex', items)]).toEqual(['a-answer'])
  })

  it('offers a Claude turn only when its record kept where to cut', () => {
    const items = [
      row('turn-a', turn('a', FINISHED)),
      row('a-last', said('copied in from history'), inTurn('turn-a')),
      row('turn-b', turn('b', { ...FINISHED, forkPoint: 'leaf-b' })),
      row('b-last', said('watched it finish'), inTurn('turn-b'))
    ]

    expect([...selectStructuredAgentForkRows('claude', items)]).toEqual(['b-last'])
  })

  it('never offers it on a subagent’s words', () => {
    const items = [
      row('turn-a', turn('a', FINISHED)),
      row('a-last', said('done'), inTurn('turn-a')),
      row('a-child', said('child report'), { ...inTurn('turn-a'), agentId: 'agent-1' })
    ]

    expect([...selectStructuredAgentForkRows('codex', items)]).toEqual(['a-last'])
  })
})
