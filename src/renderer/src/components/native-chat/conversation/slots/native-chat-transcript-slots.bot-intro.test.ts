import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

const at = (
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role,
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'text', text }],
  ...extra
})

function drawn(intro: NativeChatMessage[]) {
  const messages = [
    at('k1', 'user', 'kickoff', { orcaNotice: 'bot-created' }),
    ...intro,
    at('u2', 'user', 'Check my PRs'),
    at('a2', 'assistant', 'On it.')
  ]
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map((message) => (message.id.endsWith('2') ? 'u2' : 'k1')),
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: {
      active: null,
      completedByTurn: {
        k1: { startedAt: 0, thinking: false, workedSeconds: 3 },
        u2: { startedAt: 5, thinking: false, workedSeconds: 2 }
      }
    },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  }).flatMap((slot) =>
    slot.kind === 'message'
      ? [[slot.message.id, slot.status !== undefined, slot.endsResponse === true]]
      : []
  )
}

describe("a new bot's intro turn", () => {
  it('draws its greeting without the bar or actions; later turns keep both', () => {
    expect(drawn([at('a1', 'assistant', 'Hi! What should I review first?')])).toEqual([
      ['k1', false, false],
      ['a1', false, false],
      ['u2', true, false],
      ['a2', false, true]
    ])
  })

  it('keeps both when the first turn ran tools', () => {
    const read: NativeChatMessage = {
      ...at('t1', 'assistant', ''),
      blocks: [{ type: 'tool-call', name: 'Read', callId: 'c1', input: {} }]
    }
    expect(drawn([read, at('a1', 'assistant', 'Imported.')])).toContainEqual(['k1', true, false])
    expect(drawn([read, at('a1', 'assistant', 'Imported.')])).toContainEqual(['a1', false, true])
  })
})
