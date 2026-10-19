// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNativeChatMessage = vi.fn()
const sendNativeChatTypedCommand = vi.fn()

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendNativeChatTypedCommand(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))

import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'

const COMMAND = {
  kind: 'command' as const,
  id: 'command:status',
  name: 'status',
  token: '/status',
  description: 'Show status',
  skillCollision: false
}

function renderDispatch(
  agent: 'codex' | 'claude' | 'openclaude',
  onSubmitted = vi.fn(),
  extra: { onBtw?: (question: string) => void } = {}
) {
  return renderHook(() =>
    useNativeChatPickerCommandDispatch({
      agent,
      onSubmitted,
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: () => ({ settings: {}, ptyId: 'pty-1' }),
      sessionOptionsSurface: null,
      trackPendingSend: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn(),
      ...extra
    })
  )
}

describe('useNativeChatPickerCommandDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const handle = { cancel: vi.fn(), settleAfterMs: 0 }
    sendNativeChatMessage.mockReturnValue(handle)
    sendNativeChatTypedCommand.mockReturnValue(handle)
  })

  it('types Codex autocomplete commands', () => {
    const onSubmitted = vi.fn()
    const hook = renderDispatch('codex', onSubmitted)
    act(() => hook.result.current(COMMAND))

    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith('pty-1', '/status')
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(onSubmitted).toHaveBeenCalledOnce()
  })

  it.each(['claude', 'openclaude'] as const)('keeps %s autocomplete commands pasted', (agent) => {
    const hook = renderDispatch(agent)
    act(() => hook.result.current(COMMAND))

    expect(sendNativeChatMessage).toHaveBeenCalledWith('pty-1', '/status')
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it('opens /btw in the overlay instead of typing it into the PTY', () => {
    const onBtw = vi.fn()
    const hook = renderDispatch('claude', vi.fn(), { onBtw })
    act(() =>
      hook.result.current({
        kind: 'command',
        id: 'command:btw',
        name: 'btw',
        token: '/btw',
        skillCollision: false
      })
    )

    expect(onBtw).toHaveBeenCalledWith('')
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })
})
