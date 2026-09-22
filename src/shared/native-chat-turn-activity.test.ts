import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody, AgentJournalRenderItem } from './agent-session-journal-types'
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
  it('prefers the latest provider-authored activity line in the active turn', () => {
    const activity = selectStructuredAgentTurnActivity(
      [
        turnStart,
        item(2, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm test' },
          state: 'completed'
        }),
        item(3, { kind: 'status', text: 'Checking the results\nPreparing the answer' })
      ],
      'turn-1'
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
    // An ordinary status row is still a description of what the turn is doing.
    expect(
      selectStructuredAgentTurnActivity(
        [turnStart, reasoning, item(3, { kind: 'status', text: 'Updating the plan' })],
        'turn-1'
      )
    ).toEqual({ kind: 'description', text: 'Updating the plan' })
    // Provider-authored copy is unaffected, so Codex keeps its line.
    expect(
      selectStructuredAgentTurnActivity([turnStart, reasoning], 'turn-1', {
        turnId: 'turn-1',
        text: 'Running a command'
      })
    ).toEqual({ kind: 'description', text: 'Running a command' })
  })

  it('skips reasoning behind a typed turn item too', () => {
    const typedTurnStart = item(1, { kind: 'turn', turnId: 'turn-1', state: 'running' })

    expect(
      selectStructuredAgentTurnActivity(
        [
          typedTurnStart,
          item(2, {
            kind: 'message',
            role: 'reasoning',
            blocks: [{ type: 'text', text: 'Weighing two approaches' }]
          })
        ],
        'turn-1'
      )
    ).toBeNull()
  })

  it('prefers matching ephemeral provider activity over journal-derived status', () => {
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

  it('does not fall through to a journal status that repeats a recent tool label', () => {
    const activity = selectStructuredAgentTurnActivity(
      [
        turnStart,
        item(2, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm lint' },
          state: 'completed'
        }),
        item(3, { kind: 'status', text: 'Running pnpm lint' })
      ],
      'turn-1'
    )

    expect(activity).toBeNull()
  })

  it('ignores active and settled tools so the tail can use a broad fallback', () => {
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
      'turn-1'
    )

    expect(activity).toBeNull()
  })

  it('ignores diagnostic provider frames and returns nothing after the turn settles', () => {
    const diagnostic = item(2, {
      kind: 'status',
      text: 'codex · notification:new/event',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:new/event',
        payload: {
          head: '{}',
          byteLength: 2,
          digest: 'a'.repeat(64),
          truncated: false
        }
      }
    })

    expect(selectStructuredAgentTurnActivity([turnStart, diagnostic], 'turn-1')).toBeNull()
    expect(selectStructuredAgentTurnActivity([turnStart, diagnostic], null)).toBeNull()
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
    // The provider line is the SESSION'S OWN; a child running a tool of the same
    // name must not make it read as a repeat and blank the indicator.
    expect(
      selectStructuredAgentTurnActivity([turnStart, childRunningBash], 'turn-1', {
        turnId: 'turn-1',
        text: 'pnpm test'
      })
    ).toEqual({ kind: 'description', text: 'pnpm test' })
  })

  it("does not let a child's tool label suppress the parent's own status line", () => {
    expect(
      selectStructuredAgentTurnActivity(
        [turnStart, childRunningBash, item(3, { kind: 'status', text: 'pnpm test' })],
        'turn-1'
      )
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
