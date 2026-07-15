// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  sendRuntimePtyInput: vi.fn(),
  sendNativeChatAskAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn()
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => mocks.sendRuntimePtyInput(...args)
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: (terminalTabId: string) => ({ terminalTabId })
}))

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatAskAnswer: (...args: unknown[]) => mocks.sendNativeChatAskAnswer(...args),
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args)
}))

import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import type { AskPrompt } from './native-chat-interactive-prompt'

const PROMPT: AskPrompt = {
  questions: [{ question: 'q', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]
}

describe('useNativeChatInteractiveSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const handle = { cancel: mocks.cancel, settleAfterMs: 500 }
    mocks.sendNativeChatAskAnswer.mockReturnValue(handle)
    mocks.sendNativeChatMessage.mockReturnValue(handle)
  })

  it('routes a non-Claude answer through the pasted-text send path', () => {
    const { result } = renderHook(() => useNativeChatInteractiveSend('tab-1', 'pty-1', 'codex'))

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))

    // Codex commits a pasted answer: label text 'B', not option-number keystrokes.
    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      'B'
    )
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
  })

  it('routes a Claude answer through the option-number keystroke path', () => {
    const { result } = renderHook(() => useNativeChatInteractiveSend('tab-1', 'pty-1', 'claude'))

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))

    // The 2nd option is delivered as its number '2', not the label 'B' (STA-1860).
    expect(mocks.sendNativeChatAskAnswer).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      [{ raw: '2' }]
    )
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('does nothing when no option is answered', () => {
    const { result } = renderHook(() => useNativeChatInteractiveSend('tab-1', 'pty-1', 'claude'))

    let settleMs = -1
    act(() => {
      settleMs = result.current.sendAnswer(PROMPT, [{ indices: [] }])
    })

    expect(settleMs).toBe(0)
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('cancels delayed answer writes when the PTY target changes', () => {
    const { result, rerender } = renderHook(
      ({ targetPtyId }) => useNativeChatInteractiveSend('tab-1', targetPtyId, 'codex'),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [0] }]))
    rerender({ targetPtyId: 'pty-2' })

    expect(mocks.cancel).toHaveBeenCalledOnce()
  })

  it('cancels delayed answer writes before interrupting the active PTY', () => {
    const { result } = renderHook(() => useNativeChatInteractiveSend('tab-1', 'pty-1', 'claude'))

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))
    act(() => result.current.cancel())

    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.sendRuntimePtyInput).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      '\x1b'
    )
  })

  it('can cancel delayed writes without interrupting the replacement prompt', () => {
    const { result } = renderHook(() => useNativeChatInteractiveSend('tab-1', 'pty-1', 'claude'))

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))
    act(() => result.current.cancelPending())

    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.sendRuntimePtyInput).not.toHaveBeenCalled()
  })
})
