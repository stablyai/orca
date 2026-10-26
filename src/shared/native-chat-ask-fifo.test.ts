import { expect, it } from 'vitest'
import { extractPendingAsk } from './native-chat-ask'
import type { NativeChatMessage } from './native-chat-types'

type Block = NativeChatMessage['blocks'][number]

function ask(text: string): Block {
  return { type: 'tool-call', name: 'AskUserQuestion', input: { questions: [{ question: text }] } }
}
function toolResult(): Block {
  return { type: 'tool-result', output: 'ok' }
}
function assistant(id: string, blocks: Block[]): NativeChatMessage {
  return { id, role: 'assistant', timestamp: 1, source: 'transcript', blocks }
}

it('keeps the newest ask pending when an older duplicate-content ask resolves first', () => {
  const pending = extractPendingAsk([assistant('m', [ask('same'), ask('same'), toolResult()])])
  expect(pending?.questions[0]?.question).toBe('same')
})
