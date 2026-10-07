import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { agentJournalItemKey, agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalSubmission,
  AgentJournalRenderItem,
  AgentJournalTurnOutcome,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { withNativeChatCutTurnNotices } from './native-chat-cut-turn-notice'
import { hostStatesTurnScopes, nativeChatTurnMembership } from './native-chat-turn-membership'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
} from './agent-session-restart-continuation'
import { structuredAgentSessionStartFailureRowIdentity } from './structured-agent-session-start-failure-row-key'

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
const NOTICE =
  'Codex stopped while this response was in progress. You can continue in this conversation.'
let sequence = 0

function item(
  itemId: string,
  body: AgentJournalItemBody,
  /** Null for a host that predates scopes. */
  turnScope: AgentJournalTurnScope | null = THREAD
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body,
    ...(turnScope ? { turnScope } : {})
  }
}

const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })
const user = (itemId: string, scope: AgentJournalTurnScope | null = THREAD) =>
  item(itemId, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }, scope)
const reply = (itemId: string, scope: AgentJournalTurnScope | null) =>
  item(
    itemId,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: itemId }] },
    scope
  )

type Ending = {
  state: 'running' | 'completed' | 'interrupted' | 'unverifiable'
  outcome?: AgentJournalTurnOutcome
}
const CUT: Ending = { state: 'interrupted' }

function turn(
  itemId: string,
  userItemId: string,
  ending: Ending,
  scope: AgentJournalTurnScope | null = THREAD
) {
  return item(
    itemId,
    {
      kind: 'turn',
      turnId: itemId,
      userItemId,
      startedAt: 1_000,
      ...(ending.state === 'running' ? {} : { completedAt: 2_000 }),
      ...ending
    },
    scope
  )
}

/** A row the host wrote, by the identity its writer gives it. */
function hostRow(
  clientMessageId: string,
  body: AgentJournalItemBody,
  scope: AgentJournalTurnScope | null
) {
  return item(agentJournalItemKey({ provider: 'orca', clientMessageId }), body, scope)
}

/** What the crash path's exit row says, from its fact. */
const exitWords = (): AgentJournalItemBody => ({
  kind: 'status',
  ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
    agentName: 'Codex',
    surface: 'row'
  }),
  tone: 'error'
})
const exitRow = (clientMessageId: string, scope: AgentJournalTurnScope | null) =>
  hostRow(clientMessageId, exitWords(), scope)
/** A note the restart continuation leaves about its outcome, about the conversation. */
const restartNote = (text: string, tone?: 'error' | 'warning') =>
  hostRow(
    `restart-continuation:s:${text.length}`,
    { kind: 'status', text, ...(tone ? { tone } : {}) },
    THREAD
  )

function notices(items: readonly AgentJournalRenderItem[]) {
  return withNativeChatCutTurnNotices(items, { agentName: 'Codex' }).flatMap((entry, index) =>
    entry.itemId.includes('cut-turn-notice')
      ? [
          {
            index,
            text: entry.body.kind === 'status' ? entry.body.text : null,
            scope: entry.turnScope
          }
        ]
      : []
  )
}

describe('withNativeChatCutTurnNotices', () => {
  it('gives a cut turn no row explains one notice in the exit row words, after its last row', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      user('u2'),
      turn('t2', 'u2', { state: 'completed', outcome: 'success' })
    ]

    const derived = withNativeChatCutTurnNotices(items, { agentName: 'Codex' })

    expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
    const notice = derived[3]!
    expect(notice.body).toMatchObject({ tone: 'error', failure: { kind: 'providerExited' } })
    // Placed by journal position too, so any reader that sorts keeps it under the turn.
    expect(notice.sequence).toBe(items[2]!.sequence)
    expect(notice.sequenceIndex).toBeGreaterThan(0)
  })

  it('adds nothing where the crash path already wrote its exit row, scoped or about the conversation', () => {
    for (const [id, scope] of [
      ['stale-session:s:death-3-2000', inTurn('t1')],
      ['provider-exit:s:3:gen', inTurn('t1')],
      ['stale-session:s:death-3-2000', THREAD]
    ] as const) {
      const items = [
        user('u1'),
        turn('t1', 'u1', CUT),
        reply('a1', inTurn('t1')),
        exitRow(id, scope)
      ]
      expect(withNativeChatCutTurnNotices(items), id).toBe(items)
    }
  })

  // A host from before failure facts wrote the same rows with only their words.
  it("counts an older host's exit row by its writer, with no exit fact", () => {
    for (const id of ['provider-exit:s:3:gen', 'stale-session:s:death-3-2000']) {
      const items = [
        user('u1'),
        turn('t1', 'u1', CUT),
        hostRow(id, { kind: 'status', text: NOTICE, tone: 'error' }, inTurn('t1'))
      ]
      expect(withNativeChatCutTurnNotices(items), id).toBe(items)
    }
  })

  it('counts an exit row by its exit fact, whatever wrote it', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      item('other-writer', exitWords(), inTurn('t1'))
    ]
    expect(withNativeChatCutTurnNotices(items)).toBe(items)
  })

  it("still explains a cut whose only error row is the agent's own, not the stop's", () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      hostRow(
        'provider-frame:permission_denied',
        { kind: 'status', text: 'Permission denied: Bash', tone: 'error' },
        inTurn('t1')
      )
    ]
    expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
  })

  it('says nothing of a Stop, a replaced turn, a failure, an unproven end, a finished or a running turn', () => {
    for (const ending of [
      { state: 'interrupted', outcome: 'cancellation' },
      { state: 'interrupted', outcome: 'superseded' },
      { state: 'interrupted', outcome: 'failure' },
      { state: 'completed', outcome: 'failure' },
      { state: 'unverifiable' },
      { state: 'completed', outcome: 'success' },
      { state: 'completed' },
      { state: 'running' }
    ] satisfies Ending[]) {
      const items = [user('u1'), turn('t1', 'u1', ending), reply('a1', inTurn('t1'))]
      expect(withNativeChatCutTurnNotices(items), JSON.stringify(ending)).toBe(items)
    }
  })

  it("says nothing of a subagent's cut turn: the conversation's own turn speaks for it", () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', { state: 'completed', outcome: 'success' }),
      { ...turn('sub', 'u1', CUT, inTurn('t1')), agentId: 'sub-agent' }
    ]
    expect(withNativeChatCutTurnNotices(items)).toBe(items)
  })

  it('explains every cut turn in the history no row explains, each once', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      user('u2'),
      turn('t2', 'u2', CUT),
      reply('a2', inTurn('t2')),
      exitRow('provider-exit:s:4:gen', inTurn('t2')),
      user('u3'),
      turn('t3', 'u3', CUT)
    ]
    expect(notices(items)).toEqual([
      { index: 3, text: NOTICE, scope: inTurn('t1') },
      // A turn with no rows of its own takes the notice after its record.
      { index: 10, text: NOTICE, scope: inTurn('t3') }
    ])
  })

  // A quit, then a resume that did not carry the chat on: the note says the cut was not continued,
  // which is what the notice would say, so it stands alone.
  it.each([
    [AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE, 'error'],
    [AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE, 'error'],
    [AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE, 'warning']
  ] as const)(
    'takes the restart note "%s" as the one explanation of the cut it follows',
    (text, tone) => {
      const items = [
        user('u1'),
        turn('t1', 'u1', CUT),
        reply('a1', inTurn('t1')),
        user('continuation'),
        restartNote(text, tone)
      ]
      expect(withNativeChatCutTurnNotices(items)).toBe(items)
    }
  )

  // The note of a continuation that went on lands after its own message and turn. The cut keeps its
  // notice before and after it, so nothing flashes away under an automatic resume.
  it('keeps the notice once a continuation carries the chat on', () => {
    const cut = [user('u1'), turn('t1', 'u1', CUT), reply('a1', inTurn('t1'))]
    const continuing = [...cut, user('u2'), turn('t2', 'u2', { state: 'running' })]
    const continued = [...continuing, restartNote(AGENT_SESSION_RESTART_CONTINUATION_NOTE)]

    for (const items of [cut, continuing, continued]) {
      expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
    }
    // Its note carries no tone, so even with no turn recorded before it, it does not stand in.
    const noteOnly = [...cut, user('u2'), restartNote(AGENT_SESSION_RESTART_CONTINUATION_NOTE)]
    expect(notices(noteOnly)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
  })

  // An unconfirmed continuation whose turn opened before its warning: the warning is about that
  // turn, so the cut keeps its own notice beside it.
  it('keeps the notice when a restart note follows a turn the continuation opened', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      user('u2'),
      turn('t2', 'u2', { state: 'running' }),
      restartNote(AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE, 'warning')
    ]
    expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
  })

  // A send after the cut, whose new agent died before its turn opened: that exit is about the send.
  it('lets no exit row about the conversation explain a cut a message was sent after', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      user('u2'),
      exitRow('provider-exit:s:6:gen', THREAD)
    ]
    expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
  })

  // A row about the conversation speaks for the cut it follows, never across a turn that finished.
  it('lets a later exit row about the conversation explain no cut a finished turn came after', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      user('u2'),
      turn('t2', 'u2', { state: 'completed', outcome: 'success' }),
      exitRow('provider-exit:s:5:gen', THREAD)
    ]
    expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
  })

  // Read before the startup reconcile, the cut settled unverifiable; the user sent u2; the reconcile
  // then proved the old owner dead and wrote its row about the conversation after u2. That row is
  // about the cut, not the send, so it stays the one explanation.
  it("takes an owner's proven death as the explanation of the cut though a message was sent since", () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      user('u2'),
      exitRow('stale-session:s:death-3-2000', THREAD)
    ]
    expect(withNativeChatCutTurnNotices(items)).toBe(items)
  })

  it("does not take a failed start's row as the explanation of an earlier cut", () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      item(
        agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen-2')),
        exitWords(),
        THREAD
      )
    ]
    expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: inTurn('t1') }])
  })

  it('places the notice in its turn, for desktop and phone alike', () => {
    const items = [user('u1'), turn('t1', 'u1', CUT), reply('a1', inTurn('t1')), user('u2')]
    const derived = withNativeChatCutTurnNotices(items, { agentName: 'Codex' })
    const messages = projectStructuredAgentSessionMessages(derived, [], [], {
      rejectedInPlace: true
    })
    const { turnKeys } = nativeChatTurnMembership(messages, { items: derived, submissions: [] })

    const notice = messages.findIndex((message) => message.id.includes('cut-turn-notice'))
    expect(messages[notice]?.blocks).toEqual([
      expect.objectContaining({ type: 'text', text: NOTICE, tone: 'error' })
    ])
    expect(turnKeys[notice]).toBe('u1')
  })

  // A message Orca accepted and then failed to deliver after the cut is drawn in place as not sent,
  // in no turn; the cut keeps its notice in its own turn, and the exit row about that send does
  // not stand in for it.
  it('keeps the notice in its turn beside a later message drawn as not sent', () => {
    const sent = agentJournalSubmissionKey('client-u2')
    const items = [
      user('u1'),
      turn('t1', 'u1', CUT),
      reply('a1', inTurn('t1')),
      user(sent),
      exitRow('provider-exit:s:7:gen', THREAD)
    ]
    const submissions: AgentJournalSubmission[] = [
      {
        clientMessageId: 'client-u2',
        fence: 2,
        payloadFingerprint: 'fp-u2',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: NOTICE,
        submittedAt: 50,
        resolvedAt: 60
      }
    ]
    const derived = withNativeChatCutTurnNotices(items, { agentName: 'Codex' })
    const messages = projectStructuredAgentSessionMessages(derived, [], submissions, {
      rejectedInPlace: true
    })
    const { turnKeys } = nativeChatTurnMembership(messages, { items: derived, submissions })

    const notice = messages.findIndex((message) => message.id.includes('cut-turn-notice'))
    expect(turnKeys[notice]).toBe('u1')
    expect(messages.find((message) => message.id === sent)).toMatchObject({ unsent: true })
  })

  it('reads a journal from a host that states no scope, without making it look like one that does', () => {
    const items = [
      user('u1', null),
      turn('t1', 'u1', CUT, null),
      reply('a1', null),
      user('u2', null)
    ]

    const derived = withNativeChatCutTurnNotices(items, { agentName: 'Codex' })

    expect(notices(items)).toEqual([{ index: 3, text: NOTICE, scope: undefined }])
    expect(hostStatesTurnScopes(derived)).toBe(false)
  })

  it('reads the older status-row turn record, and keeps each notice the same object across reads', () => {
    const record = item(
      't1',
      {
        kind: 'status',
        text: '',
        turnLifecycle: {
          turnId: 't1',
          userItemId: 'u1',
          state: 'interrupted',
          startedAt: 1_000,
          completedAt: 2_000
        }
      },
      null
    )
    const items = [user('u1', null), record]

    const first = withNativeChatCutTurnNotices(items)
    const second = withNativeChatCutTurnNotices([...items])

    expect(first).toHaveLength(3)
    expect(second[2]).toBe(first[2])
  })
})
