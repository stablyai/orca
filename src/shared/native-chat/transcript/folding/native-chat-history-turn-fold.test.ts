import { expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTextBlock } from '../../native-chat-types'
import { nativeChatHistoryTurnFold, nativeChatTurnFoldRow } from './native-chat-turn-fold'
const SETTLED = new Set(['turn-1'])
const NONE = new Set<string>()

function message(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  presentation?: NativeChatTextBlock['presentation']
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text, presentation }],
    timestamp: 1,
    source: 'transcript'
  }
}

const PROMPT = message('prompt', 'user', 'Propose the change.')
const ANSWER = message('answer', 'assistant', 'The final reply, completed after the checklist.')
const WORK: NativeChatMessage = {
  id: 'work',
  role: 'assistant',
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }]
}

it('retains only prepended history disclosures until an explicit collapse, while ordinary completion still folds', () => {
  const messages: NativeChatMessage[] = [PROMPT, WORK, ANSWER]
  const rows = messages.map((item) => nativeChatTurnFoldRow(item, 'turn-1', undefined))
  const initial = nativeChatHistoryTurnFold(null, {
    scope: 'a',
    messages: messages.slice(1),
    rows: rows.slice(1).map((r) => ({ ...r, turnKey: undefined })),
    expandedTurnKeys: NONE,
    settledTurnKeys: SETTLED
  })
  const input = { scope: 'a', messages, rows, expandedTurnKeys: NONE, settledTurnKeys: SETTLED }
  const retained = nativeChatHistoryTurnFold(initial, input)
  expect(retained.fold.foldedRows.size).toBe(0)
  expect(retained.expandedTurnKeys.has('turn-1')).toBe(true)
  expect(nativeChatHistoryTurnFold(retained, input).fold.foldedRows.size).toBe(0)
  const collapsed = nativeChatHistoryTurnFold(retained, { ...input, expandedTurnKeys: new Set() })
  expect([...collapsed.fold.foldedRows]).toEqual([1])
  expect([
    ...nativeChatHistoryTurnFold(retained, { ...input, scope: 'b' }).fold.foldedRows
  ]).toEqual([1])
  const running = nativeChatHistoryTurnFold(null, { ...input, settledTurnKeys: NONE })
  expect([...nativeChatHistoryTurnFold(running, input).fold.foldedRows]).toEqual([1])
})
