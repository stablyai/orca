import { beforeEach, expect, it, vi } from 'vitest'
import type { StructuredPromptDeliveryResult } from '@/lib/agent-session/launch/structured-agent-session-launch-prompt'

const mocks = vi.hoisted(() => ({ start: vi.fn(), toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ groupsByWorktree: {} }) } }))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.start
}))

import { launchNativeChatFork } from './native-chat-fork-launch'

function askAside(delivery: StructuredPromptDeliveryResult) {
  mocks.start.mockReturnValue({
    sessionId: 'side',
    executionHostId: 'local',
    launchResult: Promise.resolve({ sessionId: 'side', fence: 1 }),
    promptDeliveryResult: Promise.resolve(delivery),
    isVisibilityUnknown: () => false
  })
  return launchNativeChatFork({
    agent: 'claude',
    worktreeId: 'wt-1',
    target: { kind: 'local' },
    forkFrom: { sessionId: 'src', throughItemId: 'reply-1' },
    surfaceAddress: { worktreeId: 'wt-1', precedingTabIds: [] },
    side: { question: 'why?' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('keeps the question with the caller and says once that it never went', async () => {
  const outcome = await askAside({ delivered: false, failureNotified: false })

  expect(mocks.start.mock.calls[0][2]).toMatchObject({
    prompt: 'why?',
    promptKeptByCaller: true,
    activate: false
  })
  expect(outcome).toEqual({
    chat: { sessionId: 'side', executionHostId: 'local' },
    question: 'failed'
  })
  expect(mocks.toastError).toHaveBeenCalledTimes(1)
})

it('tells the user to check the side chat when delivery is unconfirmed', async () => {
  const outcome = await askAside({ delivered: false, failureNotified: false, unconfirmed: true })

  expect(outcome.question).toBe('unconfirmed')
  expect(mocks.toastError).toHaveBeenCalledTimes(1)
})

it('reports a delivered question as sent, silently', async () => {
  const outcome = await askAside({ delivered: true, failureNotified: false })

  expect(outcome.question).toBe('sent')
  expect(mocks.toastError).not.toHaveBeenCalled()
})
