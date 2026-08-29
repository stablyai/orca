// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNativeChatMessageVerified = vi.fn()
const typeNativeChatCommand = vi.fn()

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessageVerified: (...args: unknown[]) => sendNativeChatMessageVerified(...args),
  typeNativeChatCommand: (...args: unknown[]) => typeNativeChatCommand(...args)
}))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: vi.fn(),
  waitForNativeChatPtyIdle: vi.fn()
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'

function renderDispatch(agent: 'codex' | 'claude' | 'openclaude') {
  return renderHook(() =>
    useNativeChatSessionOptionCommand({
      agent,
      disabled: false,
      resolveTarget: () => ({ settings: {}, ptyId: 'pty-1' }),
      setHistory: vi.fn()
    })
  )
}

describe('useNativeChatSessionOptionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendNativeChatMessageVerified.mockResolvedValue(true)
    typeNativeChatCommand.mockResolvedValue(true)
  })

  it('types Codex option commands even without caller delivery metadata', async () => {
    const hook = renderDispatch('codex')
    await act(() => hook.result.current.dispatch('/model'))

    expect(typeNativeChatCommand).toHaveBeenCalledWith(
      {},
      'pty-1',
      '/model',
      expect.any(AbortSignal)
    )
    expect(sendNativeChatMessageVerified).not.toHaveBeenCalled()
  })

  it.each(['claude', 'openclaude'] as const)('keeps %s option commands pasted', async (agent) => {
    const hook = renderDispatch(agent)
    await act(() => hook.result.current.dispatch('/model sonnet', { delivery: 'type' }))

    expect(sendNativeChatMessageVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      '/model sonnet',
      expect.any(AbortSignal)
    )
    expect(typeNativeChatCommand).not.toHaveBeenCalled()
  })
})
