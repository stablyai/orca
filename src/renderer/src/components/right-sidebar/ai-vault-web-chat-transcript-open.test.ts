import { beforeEach, expect, test, vi } from 'vitest'

const openWebChatTranscript = vi.fn()
const store: {
  activeWorktreeId: string | null
  openWebChatTranscript: typeof openWebChatTranscript
} = {
  activeWorktreeId: 'w1',
  openWebChatTranscript
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

import { openWebChatSessionTranscript } from './ai-vault-web-chat-transcript-open'

beforeEach(() => {
  openWebChatTranscript.mockClear()
  store.activeWorktreeId = 'w1'
})

test('opens a web-chat transcript tab with the session values', () => {
  openWebChatSessionTranscript({ agent: 'gemini-web', sessionId: 'GEMINI/c_1', title: '표 대화' })
  expect(openWebChatTranscript).toHaveBeenCalledWith({
    agent: 'gemini-web',
    sessionId: 'GEMINI/c_1',
    title: '표 대화',
    worktreeId: 'w1'
  })
})

test('ignores non-web sessions (web-only caller guard)', () => {
  openWebChatSessionTranscript({ agent: 'claude', sessionId: 's1', title: 'T' })
  expect(openWebChatTranscript).not.toHaveBeenCalled()
})

test('does nothing without an active worktree', () => {
  store.activeWorktreeId = null
  openWebChatSessionTranscript({ agent: 'gemini-web', sessionId: 'c_1', title: 'T' })
  expect(openWebChatTranscript).not.toHaveBeenCalled()
})
