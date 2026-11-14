import { describe, expect, it } from 'vitest'
import {
  nativeChatTurnReplyPreviews,
  projectAgentSessionConversationOutline,
  truncateOutlinePreview
} from '../../../../../../shared/agent-session/agent-session-conversation-outline'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

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

const JOURNAL: AgentJournalRenderItem[] = [
  user(1, [{ type: 'text', text: '  Fix   the\nparser  ' }]),
  row(2, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'On it.' }] }),
  row(3, { kind: 'tool-call', name: 'Read', state: 'completed', input: { file_path: 'a.ts' } }),
  // Imported tool results fold into the prior turn; accompanying harness text draws no row.
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
  // Crash recovery may append older observations; journal order remains authoritative.
  { ...user(12, [{ type: 'text', text: 'Observed earlier' }]), observedAt: 1_009.5 }
]

describe('conversation outline parity with the loaded rail', () => {
  // Name the running turn so clients without the steer loaded can identify its shared reply.
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

  it('lists only messages a person wrote, each with its own reply', () => {
    const mail = row(3, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
      from: {
        kind: 'agent',
        senders: [],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'terminal',
          dispatchId: null,
          messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'sender-1' }]
        }
      }
    })
    const journal: AgentJournalRenderItem[] = [
      user(1, [{ type: 'text', text: 'Fix the parser' }]),
      row(2, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'On it.' }] }),
      mail,
      row(4, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Read it.' }] }),
      user(5, [{ type: 'text', text: 'Thanks' }])
    ]
    expect(projectAgentSessionConversationOutline(journal, [])).toEqual([
      { itemId: 'item-1', sequence: 1, preview: 'Fix the parser', imageCount: 0, reply: 'On it.' },
      { itemId: 'item-5', sequence: 5, preview: 'Thanks', imageCount: 0 }
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
