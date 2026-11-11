// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatPtyComposerSend } from './composer/submit/use-native-chat-pty-composer-send'
import { sendNativeChatMessage } from './session/terminal/send/native-chat-runtime-send'
import { track } from '@/diagnostics/telemetry/telemetry'
import type { NativeChatPtySubmissionOutcome } from './session/terminal/send/native-chat-pty-send-queue'
import { resetNativeChatPtySendQueuesForTests } from './session/terminal/send/native-chat-pty-send-queue'
import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'

vi.mock('@/diagnostics/telemetry/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: () => 'codex'
}))
vi.mock('../../store/index', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: () => {} }) }
}))
vi.mock(import('./session/terminal/send/native-chat-runtime-send'), async (importOriginal) => {
  const runtime = await importOriginal()
  return { ...runtime, sendNativeChatMessage: vi.fn(runtime.sendNativeChatMessage) }
})
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-send', () => ({
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: vi.fn()
}))

afterEach(() => {
  cleanup()
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
  vi.mocked(sendNativeChatMessage).mockReset()
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

it('does not use refused PTY writes as predecessor evidence for a later send', async () => {
  vi.useFakeTimers()
  vi.mocked(sendRuntimePtyInputVerified).mockResolvedValueOnce(false).mockResolvedValue(true)
  const hook = renderHook(() =>
    useNativeChatPtyComposerSend(composerArgs({ recallSource: { messages: [] } }))
  )
  await act(async () => {
    expect(hook.result.current()).toBe(true)
    await vi.runAllTimersAsync()
  })
  await act(async () => {
    expect(hook.result.current()).toBe(true)
    await vi.runAllTimersAsync()
  })
  expect(followUps()).toEqual([])
})

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
