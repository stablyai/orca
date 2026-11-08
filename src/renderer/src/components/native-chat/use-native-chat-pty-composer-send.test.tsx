// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatPtyComposerSend } from './composer/submit/use-native-chat-pty-composer-send'
import { sendNativeChatMessage } from './session/terminal/send/native-chat-runtime-send'
import { track } from '@/lib/telemetry'
import type { NativeChatPtySubmissionOutcome } from './session/terminal/send/native-chat-pty-send-queue'

vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'codex' }))
vi.mock('../../store/index', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: () => {} }) }
}))
vi.mock('./session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn()
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

type SendArgs = Parameters<typeof useNativeChatPtyComposerSend>[0]

function composerArgs(overrides: Partial<SendArgs>): SendArgs {
  return {
    agent: 'codex',
    draft: 'Follow up',
    draftScopeKey: 'pty-telemetry',
    imageAttachments: [],
    disabled: false,
    isDispatchingSessionOption: false,
    launchDraftResolved: true,
    resolveTarget: () => ({ ptyId: 'pty-telemetry' }),
    classifySend: () => 'chat',
    sessionOptionsSurface: null,
    terminalTabId: 'tab-telemetry',
    trackPendingSend: () => {},
    setDraft: () => {},
    setCaret: () => {},
    clearSkillOrigin: () => {},
    clearImageAttachments: () => {},
    setNotice: () => {},
    ...overrides
  }
}

const followUps = () =>
  vi.mocked(track).mock.calls.filter(([name]) => name === 'native_chat_follow_up_sent')

it('counts a successfully retried PTY follow-up only after submission', async () => {
  const delivery = Promise.withResolvers<NativeChatPtySubmissionOutcome>()
  vi.mocked(sendNativeChatMessage)
    .mockReturnValueOnce({
      cancel: () => {},
      settleAfterMs: 0,
      outcome: Promise.resolve('not-submitted')
    })
    .mockReturnValueOnce({ cancel: () => {}, settleAfterMs: 0, outcome: delivery.promise })
  const hook = renderHook(() =>
    useNativeChatPtyComposerSend(
      composerArgs({
        recallSource: {
          messages: [
            { id: 'prior-user', role: 'user', blocks: [], timestamp: 1, source: 'transcript' },
            {
              id: 'failed-attempt',
              role: 'user',
              blocks: [],
              timestamp: 2,
              source: 'transcript',
              unsent: true,
              awaitsRetry: true
            }
          ]
        }
      })
    )
  )
  await act(async () => expect(hook.result.current()).toBe(true))
  expect(followUps()).toEqual([])
  await act(async () => expect(hook.result.current({ text: 'Follow up' })).toBe(true))
  expect(followUps()).toEqual([])
  await act(async () => delivery.resolve('submitted'))
  expect(followUps()).toEqual([
    ['native_chat_follow_up_sent', { agent_kind: 'codex', runtime: 'local', client: 'desktop' }]
  ])
})

it('counts a rapid PTY follow-up after its pending predecessor submits', async () => {
  const first = Promise.withResolvers<NativeChatPtySubmissionOutcome>()
  const second = Promise.withResolvers<NativeChatPtySubmissionOutcome>()
  vi.mocked(sendNativeChatMessage)
    .mockReturnValueOnce({ cancel: () => {}, settleAfterMs: 0, outcome: first.promise })
    .mockReturnValueOnce({ cancel: () => {}, settleAfterMs: 0, outcome: second.promise })
  const args = composerArgs({ recallSource: { messages: [] }, onOptimisticSend: () => 'first' })
  const hook = renderHook(useNativeChatPtyComposerSend, { initialProps: args })
  await act(async () => expect(hook.result.current()).toBe(true))
  hook.rerender({
    ...args,
    onOptimisticSend: () => 'second',
    recallSource: {
      messages: [
        {
          id: 'pending:first',
          role: 'user',
          blocks: [],
          timestamp: 1,
          source: 'transcript',
          pendingSend: 'queued'
        }
      ]
    }
  })
  await act(async () => expect(hook.result.current()).toBe(true))
  await act(async () => first.resolve('submitted'))
  expect(followUps()).toEqual([])
  await act(async () => second.resolve('submitted'))
  expect(followUps()).toEqual([
    ['native_chat_follow_up_sent', { agent_kind: 'codex', runtime: 'local', client: 'desktop' }]
  ])
})
