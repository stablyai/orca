// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  sendRuntimePtyInput: vi.fn(),
  sendNativeChatAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn()
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => mocks.sendRuntimePtyInput(...args)
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: (terminalTabId: string) => ({ terminalTabId })
}))

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatAnswer: (...args: unknown[]) => mocks.sendNativeChatAnswer(...args),
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args)
}))

import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'

describe('useNativeChatInteractiveSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const handle = { cancel: mocks.cancel, settleAfterMs: 500 }
    mocks.sendNativeChatAnswer.mockReturnValue(handle)
    mocks.sendNativeChatMessage.mockReturnValue(handle)
  })

  it('cancels delayed answer writes when the PTY target changes', () => {
    const { result, rerender } = renderHook(
      ({ targetPtyId }) => useNativeChatInteractiveSend('tab-1', targetPtyId, 'codex'),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.sendAnswer('continue'))
    rerender({ targetPtyId: 'pty-2' })

    expect(mocks.cancel).toHaveBeenCalledOnce()
  })

  it('cancels delayed answer writes before interrupting the active PTY', () => {
    const { result } = renderHook(() => useNativeChatInteractiveSend('tab-1', 'pty-1', 'claude'))

    act(() => result.current.sendAnswer('one\ntwo'))
    act(() => result.current.cancel())

    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.sendRuntimePtyInput).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      '\x1b'
    )
  })
})
