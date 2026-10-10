import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS,
  nativeChatTurnReplyPreviews,
  projectAgentSessionConversationOutline,
  truncateOutlinePreview
} from '../../../../shared/agent-session-conversation-outline'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatRowsInDrawOrder } from '../../../../shared/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import {
  buildNativeChatRailItems,
  nativeChatRailReplyPreview
} from './native-chat-message-rail-items'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import { nativeChatSubagentSections } from './native-chat-subagent-sections'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'
import { omitNativeChatThreadGoalRows } from './native-chat-thread-goal-rows'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

function row(sequence: number, body: AgentJournalItemBody, itemId = `item-${sequence}`) {
  return { itemId, revision: 1, sequence, observedAt: 1_000 + sequence, body }
}

function user(sequence: number, blocks: NativeChatMessage['blocks'], itemId?: string) {
  return row(sequence, { kind: 'message', role: 'user', blocks }, itemId)
}

const REJECTED: AgentJournalSubmission = {
  clientMessageId: 'client-refused',
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'rejected',
  providerItemId: null,
  reason: 'refused',
  submittedAt: 1,
  resolvedAt: 2
}

/** One journal holding every shape the transcript treats specially. */
const JOURNAL: AgentJournalRenderItem[] = [
  user(1, [{ type: 'text', text: '  Fix   the\nparser  ' }]),
  row(2, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'On it.' }] }),
  row(3, { kind: 'tool-call', name: 'Read', state: 'completed', input: { file_path: 'a.ts' } }),
  // An imported transcript's tool result, carried on a user row beside harness text: the
  // result folds into the turn above and the harness text is dropped, so it draws no row.
  user(4, [
    { type: 'tool-result', output: 'file body' },
    { type: 'text', text: '<system-reminder>Keep going.</system-reminder>' }
  ]),
  user(5, [{ type: 'image-ref', path: '/tmp/one.png' }]),
  user(6, [{ type: 'text', text: 'refused send' }], agentJournalSubmissionKey('client-refused')),
  user(7, [{ type: 'text', text: '<command-name>/compact</command-name>' }]),
  user(8, [{ type: 'text', text: '' }]),
  user(9, [
    { type: 'text', text: 'Compare these' },
    { type: 'image-ref', path: '/tmp/a.png' },
    { type: 'image-ref', path: '/tmp/b.png' }
  ]),
  row(10, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] }),
  user(11, [{ type: 'text', text: 'Thanks' }]),
  // Recovered after a crash: journalled after `Thanks`, but carrying the provider's clock from
  // before `Done.`. The transcript orders by journal position, never observation.
  { ...user(12, [{ type: 'text', text: 'Observed earlier' }]), observedAt: 1_009.5 }
]

/** The renderer's own path from journal items to slots, as the list runs it.
 *  `openSections`: the subagent sections the reader has expanded. */
function loadedSlots(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[],
  openSections: readonly string[] = []
) {
  const projection = createNativeChatMessageListProjection()(
    projectStructuredAgentSessionMessages(items, [], submissions)
  )
  const messages = omitNativeChatThreadGoalRows(
    projectNativeChatTaskListFrames(projection.conversation)
  )
  const membership = nativeChatTurnMembership(messages, { items, submissions })
  const rows = {
    messages: nativeChatRowsInDrawOrder(messages, membership.drawOrder),
    turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder)
  }
  const slots = buildNativeChatTranscriptSlots({
    ...rows,
    liveTurnKey: membership.liveTurnKey,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false,
    subagentSections: nativeChatSubagentSections(messages, projection.subagentRows),
    subagentChoices: {
      sections: new Map(openSections.map((agentId) => [agentId, true])),
      rosters: new Map()
    }
  })
  return { rows, slots }
}

function loadedRailItems(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[],
  openSections?: readonly string[]
) {
  const { rows, slots } = loadedSlots(items, submissions, openSections)
  const railItems = buildNativeChatRailItems(slots)
  return railItems.map((item) => ({
    ...item,
    reply: nativeChatRailReplyPreview(rows, railItems, item.id)
  }))
}

describe('conversation outline parity with the loaded rail', () => {
  // Except a rejected message: the desktop draws it in place and ticks it once loaded, while the
  // host's outline, which older clients read too, leaves it out.
  it('lists exactly the user messages the transcript gives a rail tick, with the same ids and previews', () => {
    const outline = projectAgentSessionConversationOutline(JOURNAL, [REJECTED])
    const rejectedId = agentJournalSubmissionKey(REJECTED.clientMessageId)
    const loadedWithRejected = loadedRailItems(JOURNAL, [REJECTED])
    expect(loadedWithRejected.filter((item) => item.id === rejectedId)).toHaveLength(1)
    const loaded = loadedWithRejected.filter((item) => item.id !== rejectedId)

    expect(outline.map((entry) => entry.itemId)).toEqual(loaded.map((item) => item.id))
    expect(
      outline.map((entry) => ({
        id: entry.itemId,
        text: entry.preview,
        hasImages: entry.imageCount > 0,
        reply: entry.reply ?? ''
      }))
    ).toEqual(loaded.map(({ id, text, hasImages, reply }) => ({ id, text, hasImages, reply })))
    // Anti-vacuous: the folded tool result, the refused send, the harness turn and the empty
    // prompt were all dropped, and the recovered row sits where it was journalled.
    expect(outline.map((entry) => entry.itemId)).toEqual([
      'item-1',
      'item-5',
      'item-9',
      'item-11',
      'item-12'
    ])
  })

  // The host serves this outline to clients of every version, so it lists what it always listed.
  it('leaves out a send a Stop took back, which the transcript still draws', () => {
    const stopped: AgentJournalSubmission = {
      ...REJECTED,
      clientMessageId: 'client-stopped',
      reason: DISPATCH_REJECTED_CANCELLED
    }
    const journal = [
      ...JOURNAL,
      user(13, [{ type: 'text', text: 'never ran' }], agentJournalSubmissionKey('client-stopped'))
    ]
    const outline = projectAgentSessionConversationOutline(journal, [REJECTED, stopped])
    // The rejected message is the desktop's own in-place row, as above.
    const rejectedId = agentJournalSubmissionKey(REJECTED.clientMessageId)
    const loaded = loadedRailItems(journal, [REJECTED, stopped]).filter(
      (item) => item.id !== rejectedId
    )

    expect(outline.map((entry) => entry.itemId)).toEqual(loaded.map((item) => item.id))
    expect(outline.map((entry) => entry.itemId)).not.toContain(
      agentJournalSubmissionKey('client-stopped')
    )
    expect(
      projectStructuredAgentSessionMessages(journal, [], [REJECTED, stopped]).map(
        (message) => message.id
      )
    ).toContain(agentJournalSubmissionKey('client-stopped'))
  })

  // An imported tool result rides a user row mid-turn; it must not end the turn's reply.
  it('reads a reply past a tool result folded into the turn, loaded or outlined', () => {
    const journal = [
      user(1, [{ type: 'text', text: 'Fix it' }]),
      row(2, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Looking.' }] }),
      row(3, { kind: 'tool-call', name: 'Read', state: 'completed', input: { file_path: 'a.ts' } }),
      user(4, [{ type: 'tool-result', output: 'file body' }]),
      row(5, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Fixed.' }] })
    ]
    expect(projectAgentSessionConversationOutline(journal, []).map((entry) => entry.reply)).toEqual(
      ['Fixed.']
    )
    expect(loadedRailItems(journal, []).map((item) => item.reply)).toEqual(['Fixed.'])
  })

  // A subagent's rows are its own, not the conversation's: its prompt is no tick and
  // its prose is no reply, whether or not its section is open.
  it('never reads a subagent into the rail, as a tick or as a reply', () => {
    const journal = [
      user(1, [{ type: 'text', text: 'Fix it' }]),
      row(2, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Fixed.' }] }),
      { ...user(3, [{ type: 'text', text: 'Child task' }]), agentId: 'sub-1' },
      {
        ...row(4, {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Child done.' }]
        }),
        agentId: 'sub-1'
      }
    ]
    const outline = projectAgentSessionConversationOutline(journal, [])
    expect(outline.map(({ itemId, reply }) => ({ id: itemId, reply }))).toEqual([
      { id: 'item-1', reply: 'Fixed.' }
    ])
    // Anti-vacuous: with its section open, the child's prompt is a drawn row.
    const open = loadedSlots(journal, [], ['sub-1']).slots
    expect(open.some((slot) => slot.kind === 'message' && slot.message.id === 'item-3')).toBe(true)
    for (const sections of [[], ['sub-1']]) {
      expect(
        loadedRailItems(journal, [], sections).map(({ id, reply }) => ({ id, reply }))
      ).toEqual([{ id: 'item-1', reply: 'Fixed.' }])
    }
  })

  // A steer joins the running turn, so the host names that turn for it: a client
  // that has not loaded the steer cannot otherwise tell whose reply it shares.
  it("names the turn of a steer, and gives it that turn's reply", () => {
    const inTurn = { turnScope: { kind: 'turn' as const, turnItemId: 'turn-1' } }
    const journal: AgentJournalRenderItem[] = [
      { ...user(1, [{ type: 'text', text: 'Fix it' }]), ...inTurn },
      row(
        2,
        { kind: 'turn', turnId: 'turn-1', state: 'completed', userItemId: 'item-1', startedAt: 0 },
        'turn-1'
      ),
      {
        ...row(3, {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Looking.' }]
        }),
        ...inTurn
      },
      { ...user(4, [{ type: 'text', text: 'Also the tests' }]), ...inTurn },
      {
        ...row(5, {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Done.' }]
        }),
        ...inTurn
      }
    ]
    expect(
      projectAgentSessionConversationOutline(journal, []).map(({ itemId, turnKey, reply }) => ({
        itemId,
        turnKey,
        reply
      }))
    ).toEqual([
      { itemId: 'item-1', turnKey: undefined, reply: 'Done.' },
      { itemId: 'item-4', turnKey: 'item-1', reply: 'Done.' }
    ])
  })

  it('carries each entry its creation sequence, image count and the reply to it', () => {
    const outline = projectAgentSessionConversationOutline(JOURNAL, [REJECTED])
    expect(outline).toEqual([
      { itemId: 'item-1', sequence: 1, preview: 'Fix the parser', imageCount: 0, reply: 'On it.' },
      { itemId: 'item-5', sequence: 5, preview: '', imageCount: 1 },
      {
        itemId: 'item-9',
        sequence: 9,
        preview: 'Compare these',
        imageCount: 2,
        reply: 'Done.'
      },
      { itemId: 'item-11', sequence: 11, preview: 'Thanks', imageCount: 0 },
      { itemId: 'item-12', sequence: 12, preview: 'Observed earlier', imageCount: 0 }
    ])
  })
})

describe('reply preview', () => {
  const says = (text: string): Pick<NativeChatMessage, 'role' | 'blocks'> => ({
    role: 'assistant',
    blocks: [{ type: 'text', text }]
  })
  const asks: Pick<NativeChatMessage, 'role' | 'blocks'> = {
    role: 'user',
    blocks: [{ type: 'text', text: 'prompt' }]
  }

  it("is the turn's last assistant prose, as plain text, whatever sits between", () => {
    const fixed =
      '## Fixed\n\n```ts\nconst hidden = 1\n```\n\n- The **parser** now reads `a.ts`.\n---'
    expect(
      nativeChatTurnReplyPreviews(
        // A steer and a prompt queued for the next turn both land mid-turn.
        [asks, says('Let me look.'), asks, asks, says(fixed), says('A later turn.')],
        ['t1', 't1', 't1', 't2', 't1', 't2']
      )
    ).toEqual(
      new Map([
        ['t1', 'Fixed The parser now reads a.ts.'],
        ['t2', 'A later turn.']
      ])
    )
  })

  it('keeps earlier prose when the last message is only code, and skips a turn with none', () => {
    expect(
      nativeChatTurnReplyPreviews(
        [says('Here it is:'), says('```\ncode\n```'), asks],
        ['t1', 't1', 't2']
      )
    ).toEqual(new Map([['t1', 'Here it is:']]))
  })

  it('is cut to the preview cap', () => {
    expect(nativeChatTurnReplyPreviews([says('word '.repeat(200))], ['t1']).get('t1')).toHaveLength(
      AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS - 1
    )
  })
})

describe('outline preview truncation', () => {
  it('cuts to the cap without splitting a surrogate pair', () => {
    expect(truncateOutlinePreview('short', 10)).toBe('short')
    expect(truncateOutlinePreview('abcdef', 3)).toBe('abc')
    const emoji = 'ab\u{1F600}cd'
    // Index 3 is the low half of the emoji; the cut backs off to keep the pair whole.
    expect(truncateOutlinePreview(emoji, 3)).toBe('ab')
    expect(truncateOutlinePreview(emoji, 4)).toBe('ab\u{1F600}')
  })
})
