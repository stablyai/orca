import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { foldToolMessages } from '../../../../shared/native-chat/tools/native-chat-tool-fold'
import { pairToolBlocks } from '../../../../shared/native-chat/tools/native-chat-tool-pairs'
import {
  nativeChatWorkRunEditKey,
  nativeChatWorkRunEntries
} from '../../../../shared/native-chat-work-run'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { buildEditCards } from '../../../../shared/native-chat/tools/native-chat-edit-cards'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

const prompt = item('u', 1, {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'go' }]
})
const quiet = item('cmd', 2, {
  kind: 'tool-call',
  name: 'shell',
  callId: 'item_1',
  input: { command: 'mkdir -p src' },
  state: 'completed'
})
const thought = (id: string, sequence: number) =>
  item(id, sequence, {
    kind: 'message',
    role: 'reasoning',
    blocks: [{ type: 'text', text: `thinking ${id}` }],
    state: 'completed',
    completedAt: sequence
  })
const diff = (id: string, sequence: number, file: string) =>
  item(id, sequence, {
    kind: 'diff',
    path: `src/${file}`,
    patch: {
      head: `@@ -1 +1 @@\n-${file} old\n+${file} new`,
      digest: id,
      byteLength: 20,
      truncated: false
    }
  })

function messagesOf(items: AgentJournalRenderItem[]): NativeChatMessage[] {
  return foldToolMessages(projectStructuredAgentSessionMessages(items, [], []))
}

function cards(blocks: NativeChatMessage['blocks']): [unknown, string[]][] {
  return [...buildEditCards(blocks).editCards].map(([call, card]) => [
    call.type === 'tool-call' ? call.input : undefined,
    card.files.map((file) => file.path)
  ])
}

describe('tool results inside a work run', () => {
  // Diff results lack provider call ids; cross-row pairing must not hand them to an unrelated quiet call.
  it("keeps each row's result with its own call", () => {
    const messages = messagesOf([
      prompt,
      quiet,
      thought('r1', 3),
      diff('da', 4, 'a.ts'),
      thought('r2', 5),
      diff('db', 6, 'b.ts')
    ])
    const run = buildNativeChatTranscriptSlots({
      messages,
      turnKeys: messages.map(() => 'u'),
      liveTurnKey: undefined,
      receipts: new Map(),
      turnStatuses: { active: null, completedByTurn: {} },
      turnDiffs: new Map(),
      expandedTurnKeys: new Set(),
      isWorking: false,
      lifecycleWorking: false
    }).find((slot) => slot.kind === 'message' && slot.workRun !== undefined)
    const members = run?.kind === 'message' ? (run.workRun ?? []) : []
    expect(members.map((member) => member.id)).toEqual(['cmd', 'r1', 'da', 'r2', 'db'])
    const { blocks } = nativeChatWorkRunEntries(members)
    expect(pairToolBlocks(blocks)[0]?.result).toBeUndefined()
    expect(cards(blocks)).toEqual([
      [{ path: 'src/a.ts' }, ['src/a.ts']],
      [{ path: 'src/b.ts' }, ['src/b.ts']]
    ])
    const key = nativeChatWorkRunEditKey(members, blocks, { messageId: 'da', editKey: 'Diff:0' })
    const target = [...buildEditCards(blocks).editCards.values()].find((card) => card.key === key)
    expect(target?.files[0]?.path).toBe('src/a.ts')
  })

  it('keeps a result with its own call when rows fold into one message', () => {
    const messages = messagesOf([prompt, quiet, diff('da', 3, 'a.ts')])
    expect(messages.map((message) => message.id)).toEqual(['u', 'cmd'])
    expect(cards(messages[1]!.blocks)).toEqual([[{ path: 'src/a.ts' }, ['src/a.ts']]])
  })
})
