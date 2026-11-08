// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { emitNativeChatMessageSent } from './telemetry/native-chat-telemetry'
import { sendNativeChatMessage } from './session/terminal/send/native-chat-runtime-send'
import { useNativeChatPtyComposerSend } from './composer/submit/use-native-chat-pty-composer-send'
import { clearNativeChatComposerDraftsForTests } from './drafts/native-chat-draft-reset'

vi.mock('./telemetry/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
beforeEach(() => {
  vi.mocked(emitNativeChatMessageSent).mockClear()
  clearNativeChatComposerDraftsForTests()
})
afterEach(cleanup)

function composer(classification: 'chat' | 'command') {
  let settled!: () => void
  vi.mocked(sendNativeChatMessage).mockReturnValue({
    cancel: vi.fn(),
    settleAfterMs: 0,
    settled: new Promise<void>((resolve) => {
      settled = resolve
    })
  })
  const hook = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent: 'claude',
      draft: classification === 'chat' ? 'hello' : '/command',
      draftScopeKey: 'telemetry-tab',
      imageAttachments: [],
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pty-local' }),
      classifySend: () => classification,
      sessionOptionsSurface: null,
      terminalTabId: 'telemetry-tab',
      trackPendingSend: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
  act(() => hook.result.current())
  return { ...hook, settled, options: vi.mocked(sendNativeChatMessage).mock.calls.at(-1)![2] }
}

it('does not turn queued completion or rerender into acknowledgement', async () => {
  const { settled, rerender } = composer('command')
  expect(emitNativeChatMessageSent).not.toHaveBeenCalled()
  await act(async () => settled())
  rerender()
  expect(emitNativeChatMessageSent).toHaveBeenCalledExactlyOnceWith({
    agent: 'claude',
    runtime: 'local',
    backend: 'pty',
    action: 'command',
    outcome: 'unconfirmed'
  })
})

it('reports a refused message once even when its queue subsequently settles', async () => {
  const { options, settled } = composer('chat')
  act(() => options!.onWriteRejected!())
  await act(async () => settled())
  expect(emitNativeChatMessageSent).toHaveBeenCalledExactlyOnceWith({
    agent: 'claude',
    runtime: 'local',
    backend: 'pty',
    action: 'message',
    outcome: 'rejected'
  })
})
