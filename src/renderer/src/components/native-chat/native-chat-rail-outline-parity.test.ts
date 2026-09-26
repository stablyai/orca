import { describe, expect, it } from 'vitest'
import {
  projectAgentSessionConversationOutline,
  truncateOutlinePreview
} from '../../../../shared/agent-session-conversation-outline'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { buildNativeChatRailItems } from './native-chat-message-rail-items'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
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
  // Journalled after `Thanks` but observed before `Done.`: the transcript orders by observation.
  { ...user(12, [{ type: 'text', text: 'Observed earlier' }]), observedAt: 1_009.5 }
]

/** The renderer's own path from journal items to rail items, as the list runs it. */
function loadedRailItems(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  const projected = createNativeChatMessageListProjection()(
    projectStructuredAgentSessionMessages(items, [], submissions)
  )
  const messages = omitNativeChatThreadGoalRows(projectNativeChatTaskListFrames(projected))
  let turn: string | undefined
  const turnKeys = messages.map((message) => {
    if (message.role === 'user') {
      turn = message.id
    }
    return turn
  })
  const slots = buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    latestUserIndex: messages.findLastIndex((message) => message.role === 'user'),
    currentTurnKey: turn,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    showTurnStatus: true,
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false
  })
  return buildNativeChatRailItems(slots)
}

describe('conversation outline parity with the loaded rail', () => {
  it('lists exactly the user messages the transcript gives a rail tick, with the same ids and previews', () => {
    const outline = projectAgentSessionConversationOutline(JOURNAL, [REJECTED])
    const loaded = loadedRailItems(JOURNAL, [REJECTED])

    expect(outline.map((entry) => entry.itemId)).toEqual(loaded.map((item) => item.id))
    expect(
      outline.map((entry) => ({
        id: entry.itemId,
        text: entry.preview,
        hasImages: entry.imageCount > 0
      }))
    ).toEqual(loaded.map(({ id, text, hasImages }) => ({ id, text, hasImages })))
    // Anti-vacuous: the folded tool result, the refused send, the harness turn and the empty
    // prompt were all dropped, and the late-journalled row sits where it was observed.
    expect(outline.map((entry) => entry.itemId)).toEqual([
      'item-1',
      'item-5',
      'item-9',
      'item-12',
      'item-11'
    ])
  })

  it('carries each entry its creation sequence and image count', () => {
    const outline = projectAgentSessionConversationOutline(JOURNAL, [REJECTED])
    expect(outline).toEqual([
      { itemId: 'item-1', sequence: 1, preview: 'Fix the parser', imageCount: 0 },
      { itemId: 'item-5', sequence: 5, preview: '', imageCount: 1 },
      { itemId: 'item-9', sequence: 9, preview: 'Compare these', imageCount: 2 },
      { itemId: 'item-12', sequence: 12, preview: 'Observed earlier', imageCount: 0 },
      { itemId: 'item-11', sequence: 11, preview: 'Thanks', imageCount: 0 }
    ])
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
