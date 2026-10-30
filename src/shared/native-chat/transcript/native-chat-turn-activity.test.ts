import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../agent-session-journal-types'
import { selectStructuredAgentTurnActivity } from './native-chat-turn-activity'

function item(sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

const turnStart = item(1, {
  kind: 'status',
  text: 'Codex is working…',
  turnLifecycle: { turnId: 'turn-1', state: 'running' }
})

describe('selectStructuredAgentTurnActivity', () => {
  it('shows the latest line of the live provider activity in the active turn', () => {
    const activity = selectStructuredAgentTurnActivity(
      [
        turnStart,
        item(2, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm test' },
          state: 'completed'
        })
      ],
      'turn-1',
      { turnId: 'turn-1', text: 'Checking the results\nPreparing the answer' }
    )

    expect(activity).toEqual({ kind: 'description', text: 'Preparing the answer' })
  })

  it("never puts the model's reasoning on the indicator line", () => {
    const reasoning = item(2, {
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Let me check whether the journal already records this' }]
    })

    // Reasoning is the turn's content; the row says the turn is thinking instead.
    expect(selectStructuredAgentTurnActivity([turnStart, reasoning], 'turn-1')).toBeNull()
    // Provider-authored copy is unaffected, so Codex keeps its line.
    expect(
      selectStructuredAgentTurnActivity([turnStart, reasoning], 'turn-1', {
        turnId: 'turn-1',
        text: 'Running a command'
      })
    ).toEqual({ kind: 'description', text: 'Running a command' })
  })

  it('shows matching ephemeral provider activity, never an older journal status', () => {
    const activity = selectStructuredAgentTurnActivity(
      [turnStart, item(2, { kind: 'status', text: 'Older journal status' })],
      'turn-1',
      { turnId: 'turn-1', text: 'Inspecting the session wire' }
    )

    expect(activity).toEqual({ kind: 'description', text: 'Inspecting the session wire' })
  })

  it('ignores ephemeral activity from another or settled turn', () => {
    const providerActivity = { turnId: 'turn-1', text: 'Inspecting the session wire' }

    expect(selectStructuredAgentTurnActivity([turnStart], 'turn-2', providerActivity)).toBeNull()
    expect(selectStructuredAgentTurnActivity([turnStart], null, providerActivity)).toBeNull()
  })

  it.each([
    ['active', 'Still running pnpm test'],
    ['most recently settled', 'Running shell pnpm lint now']
  ])('never repeats the %s tool label as provider activity', (_kind, text) => {
    const activity = selectStructuredAgentTurnActivity(
      [
        turnStart,
        item(2, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm test' },
          state: 'running'
        }),
        item(3, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm lint' },
          state: 'completed'
        })
      ],
      'turn-1',
      { turnId: 'turn-1', text }
    )

    expect(activity).toBeNull()
  })
})

describe('selectStructuredAgentTurnActivity — which agent it answers for', () => {
  /** A row a subagent produced, which shares the session's journal. */
  function childItem(sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
    return { ...item(sequence, body), agentId: 'task-1', producerKind: 'agent' }
  }

  const childRunningBash = childItem(2, {
    kind: 'tool-call',
    name: 'shell',
    input: { command: 'pnpm test' },
    state: 'running'
  })

  it("does not let a child's tool label suppress the provider's line for the parent", () => {
    // Child tool labels cannot dedupe the session parent’s own provider activity line.
    expect(
      selectStructuredAgentTurnActivity([turnStart, childRunningBash], 'turn-1', {
        turnId: 'turn-1',
        text: 'pnpm test'
      })
    ).toEqual({ kind: 'description', text: 'pnpm test' })
  })

  it("still suppresses a line repeating the session's OWN running tool", () => {
    // The scoping must not disable the de-duplication it was narrowing.
    expect(
      selectStructuredAgentTurnActivity(
        [
          turnStart,
          item(2, {
            kind: 'tool-call',
            name: 'shell',
            input: { command: 'pnpm test' },
            state: 'running'
          })
        ],
        'turn-1',
        { turnId: 'turn-1', text: 'pnpm test' }
      )
    ).toBeNull()
  })
})
