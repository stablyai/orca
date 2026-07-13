import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const launchSpy = vi.fn()
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: (a: unknown) => launchSpy(a)
}))
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: unknown) => toastError(m), success: vi.fn() } }))

import { resolveWebChatResumeAgent, resumeWebChatAsLocalAgent } from './ai-vault-web-chat-resume'

beforeEach(() => {
  launchSpy.mockClear()
  toastError.mockClear()
  ;(globalThis as { window?: unknown }).window = {
    api: {
      nativeChat: {
        readSession: vi.fn(async () => ({
          messages: [
            {
              id: 'm0',
              role: 'user',
              blocks: [{ type: 'text', text: '안녕' }],
              timestamp: 0,
              source: 'transcript'
            }
          ]
        }))
      }
    }
  }
})
afterEach(() => vi.clearAllMocks())

test('resolveWebChatResumeAgent: 유효 native-chat 에이전트만 통과', () => {
  expect(resolveWebChatResumeAgent('claude', [])).toBe('claude')
  expect(resolveWebChatResumeAgent('blank', [])).toBeNull()
  expect(resolveWebChatResumeAgent(null, [])).toBeNull()
  expect(resolveWebChatResumeAgent('claude', ['claude'])).toBeNull() // disabled
  expect(resolveWebChatResumeAgent('gemini', [])).toBeNull() // native-chat 미지원
})

test('resumeWebChatAsLocalAgent: 시드로 launchAgentInNewTab 호출', async () => {
  await resumeWebChatAsLocalAgent({
    session: { agent: 'gemini-web', sessionId: 'c_1', title: 'T' },
    agent: 'claude',
    worktreeId: 'w1'
  })
  expect(launchSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      worktreeId: 'w1',
      promptDelivery: 'submit-after-ready',
      launchSource: 'web_chat_resume',
      prompt: expect.stringContaining('Gemini에서')
    })
  )
})

test('resumeWebChatAsLocalAgent: 빈 대화면 launch 안 하고 toast', async () => {
  ;(
    window as unknown as { api: { nativeChat: { readSession: unknown } } }
  ).api.nativeChat.readSession = vi.fn(async () => ({ messages: [] }))
  await resumeWebChatAsLocalAgent({
    session: { agent: 'gemini-web', sessionId: 'c_1', title: 'T' },
    agent: 'claude',
    worktreeId: 'w1'
  })
  expect(launchSpy).not.toHaveBeenCalled()
  expect(toastError).toHaveBeenCalled()
})

test('resumeWebChatAsLocalAgent: 세션 읽기 에러면 launch 안 하고 toast', async () => {
  ;(
    window as unknown as { api: { nativeChat: { readSession: unknown } } }
  ).api.nativeChat.readSession = vi.fn(async () => ({ error: 'boom' }))
  await resumeWebChatAsLocalAgent({
    session: { agent: 'gemini-web', sessionId: 'c_1', title: 'T' },
    agent: 'claude',
    worktreeId: 'w1'
  })
  expect(launchSpy).not.toHaveBeenCalled()
  expect(toastError).toHaveBeenCalled()
})
