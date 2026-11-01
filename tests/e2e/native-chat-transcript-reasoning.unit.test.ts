// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('../../src/renderer/src/components/native-chat/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import { createElement } from 'react'
import { NativeChatMessageList } from '../../src/renderer/src/components/native-chat/NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from '../../src/renderer/src/components/native-chat/native-chat-message-list-test-viewport'
import { render } from '../../src/renderer/src/components/native-chat/native-chat-tooltip-test-harness'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

it('renders terminal file reasoning before its equal-clock answer without journal authority', async () => {
  const { Readable } = await import('node:stream')
  const { decodeTranscriptStream } =
    await import('../../src/main/native-chat/transcript-stream-lines')
  const { decodeClaudeTranscriptLine } =
    await import('../../src/main/native-chat/transcript-line-decoders')
  const records = [
    { type: 'user', uuid: 'prompt', message: { role: 'user', content: 'Explain the result' } },
    {
      type: 'assistant',
      uuid: 'z-thinking',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'File reasoning before final answer' }]
      }
    },
    {
      type: 'assistant',
      uuid: 'a-answer',
      message: { role: 'assistant', content: 'The final file answer' }
    }
  ]
    .map((row) => `${JSON.stringify({ ...row, timestamp: '2026-06-01T10:00:00Z' })}\n`)
    .join('')
  const { messages } = await decodeTranscriptStream(
    Readable.from([records]),
    'terminal.jsonl',
    0,
    decodeClaudeTranscriptLine,
    true,
    Infinity,
    true
  )
  render(
    createElement(NativeChatMessageList, {
      session: {
        messages,
        status: 'ready',
        sessionId: 'session-1',
        agent: 'claude',
        hasMore: false,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      },
      isWorking: false,
      expandSignal: true
    })
  )
  const disclosure = screen.getByRole('button', { name: /^Reasoning/ })
  if (disclosure.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(disclosure)
  }
  const thought = screen.getByText('File reasoning before final answer')
  const answer = screen.getByText('The final file answer')
  expect(thought.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
