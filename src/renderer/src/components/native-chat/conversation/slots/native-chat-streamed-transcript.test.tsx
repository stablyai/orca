// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  noteStreamedTextRevision,
  rowsBesideStreamedText
} from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { createNativeChatMessageListProjection } from '../projection/native-chat-message-list-projection'
import { createNativeChatConversationProjection } from '../projection/native-chat-conversation-projection'
import { useNativeChatTurnMembership } from './use-native-chat-turn-membership'
import { useNativeChatTranscriptSlots } from './use-native-chat-transcript-slots'
import { useNativeChatTurnDiffs } from '../../tools/diffs/use-native-chat-turn-diffs'
import { createNativeChatWaitingSlotProjection } from './native-chat-transcript-slot-selection'
import { createNativeChatCiRowProjection } from '../../../../../../shared/native-chat/transcript/notices/native-chat-pull-request-event'
import { createNativeChatStreamedTranscript } from './native-chat-streamed-transcript'

it.each([128, 1280])(
  'touches only changed content through the desktop transcript at %s rows',
  (size) => {
    let reads = 0
    const row = (index: number, text: string): NativeChatMessage => {
      const blocks: NativeChatMessage['blocks'] = [{ type: 'text', text }]
      return {
        id: `row-${index}`,
        source: 'transcript',
        role: index === 0 ? 'user' : 'assistant',
        timestamp: index,
        journalPosition: { sequence: index + 1, index: 0 },
        get blocks() {
          reads++
          return blocks
        }
      }
    }
    const messages = Array.from({ length: size }, (_, index) => row(index, 'words'))
    const items: AgentJournalRenderItem[] = messages.map((message, index) => ({
      itemId: message.id,
      sequence: index + 1,
      revision: 1,
      observedAt: index,
      turnScope: { kind: 'turn', turnItemId: 'turn' },
      body: {
        kind: 'message',
        role: message.role === 'user' ? 'user' : 'assistant',
        blocks: message.blocks
      }
    }))
    const latestTurn = {
      itemId: 'turn',
      observedAt: 1,
      turn: { turnId: 'turn', startedAt: 1, state: 'running' as const, userItemId: 'row-0' }
    }
    const submissions: [] = []
    const receipts = new Map()
    const expandedTurnKeys = new Set<string>()
    const turnStatuses = { active: null, completedByTurn: {} }
    const subagentRows: [] = []
    const list = createNativeChatMessageListProjection()
    const conversation = createNativeChatConversationProjection()
    const split = createNativeChatWaitingSlotProjection()
    const hideCiRows = createNativeChatCiRowProjection()
    const { result, rerender } = renderHook(
      ({ messages }: { messages: NativeChatMessage[] }) => {
        const folded = list(messages, { items, submissions, latestTurn }).conversation
        const shown = conversation(folded, true)
        const membership = useNativeChatTurnMembership(shown, items, submissions, latestTurn)
        const turns = { ...membership, ...hideCiRows(membership) }
        const turnDiffs = useNativeChatTurnDiffs(turns, subagentRows)
        const transcript = useNativeChatTranscriptSlots({
          ...turns,
          receipts,
          expandedTurnKeys,
          turnStatuses,
          turnDiffs,
          isWorking: true,
          lifecycleWorking: true,
          line: { tailRow: 'activity', thinking: false }
        })
        return {
          ...split(transcript.slots, items, false, submissions, { latestTurn, working: true }),
          turnKeys: turns.turnKeys,
          turnDiffs
        }
      },
      { initialProps: { messages } }
    )
    const before = result.current
    reads = 0
    const next = messages.slice()
    next[size - 1] = row(size - 1, 'words extended')
    noteStreamedTextRevision(next, messages, [size - 1])
    rerender({ messages: next })
    expect(reads).toBeLessThan(80)
    expect(result.current.slots.at(-1)).toMatchObject({
      message: { blocks: [{ type: 'text', text: 'words extended' }] }
    })
    expect(result.current.slots[0]).toBe(before.slots[0])
    expect(result.current.turnKeys).toBe(before.turnKeys)
    expect(result.current.turnDiffs).toBe(before.turnDiffs)
    expect(rowsBesideStreamedText(result.current.slots)).toBe(rowsBesideStreamedText(before.slots))
  }
)

it('keeps generated previews and response-control height when completed answer words change', () => {
  const messages: NativeChatMessage[] = [
    {
      id: 'image',
      source: 'transcript',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: '', presentation: 'generated-image' },
        { type: 'image-ref', path: '/tmp/result.png' }
      ]
    },
    {
      id: 'answer',
      source: 'transcript',
      role: 'assistant',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'Here is your image.' }]
    }
  ]
  const input = {
    messages,
    turnKeys: ['turn', 'turn'],
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: { turn: { workedSeconds: 1 } } },
    expandedTurnKeys: new Set(['turn']),
    turnDiffs: new Map(),
    isWorking: false,
    lifecycleWorking: false
  }
  const project = createNativeChatStreamedTranscript()
  const before = project(input)
  const next = messages.slice()
  next[1] = { ...messages[1]!, blocks: [{ type: 'text', text: 'Here is the finished image.' }] }
  noteStreamedTextRevision(next, messages, [1])
  const after = project({ ...input, messages: next })
  expect(after.slots.at(-1)).toMatchObject({
    message: {
      blocks: [
        { type: 'text', text: 'Here is the finished image.' },
        { type: 'image-ref', path: '/tmp/result.png' }
      ]
    },
    estimatedHeight: before.slots.at(-1)!.estimatedHeight
  })
})
