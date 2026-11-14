// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../../../../shared/agent-launch/startup/agent-tui-input-clear'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'

const { order, sendVerified, sendInput, arm } = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    arm: vi.fn(() => {
      order.push('arm')
    }),
    sendVerified: vi.fn(async () => {
      order.push('send')
      return true
    }),
    sendInput: vi.fn(async () => {
      order.push('clear')
      return true
    })
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
vi.mock('../../terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessageVerified: (...args: unknown[]) => sendVerified(...args),
  typeNativeChatCommand: vi.fn()
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendInput(...args)
}))
vi.mock('./claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: () => ({
    ready: Promise.resolve(),
    result: Promise.resolve('applied'),
    arm,
    startDetection: vi.fn(),
    dispose: vi.fn()
  })
}))

const TARGET = { ptyId: 'pty-1' }

describe('useNativeChatSessionOptionCommand', () => {
  beforeEach(() => {
    order.length = 0
    sendVerified.mockClear()
    sendInput.mockClear()
    arm.mockClear()
    sendInput.mockImplementation(async () => {
      order.push('clear')
      return true
    })
    sendVerified.mockImplementation(async () => {
      order.push('send')
      return true
    })
  })

  it('clears a leftover terminal draft and waits for that ack before arming a model switch', async () => {
    const { result } = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'claude',
        disabled: false,
        resolveTarget: () => TARGET
      })
    )

    await act(async () => {
      await result.current.dispatch('/model opus', {
        detectAgentInteraction: 'claude-model-switch-confirmation',
        expectedChoiceLabel: 'Opus'
      })
    })

    expect(sendInput).toHaveBeenCalledWith(TARGET.ptyId, AGENT_TUI_CLEAR_INPUT_MAX, 'driving')
    expect(order).toEqual(['clear', 'arm', 'send'])
  })

  it('does not submit the model command when the draft clear is rejected', async () => {
    sendInput.mockImplementation(async () => {
      order.push('clear')
      return false
    })
    const { result } = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'claude',
        disabled: false,
        resolveTarget: () => TARGET
      })
    )

    await expect(
      act(async () => {
        await result.current.dispatch('/model opus', {
          detectAgentInteraction: 'claude-model-switch-confirmation'
        })
      })
    ).rejects.toThrow('The terminal did not accept the command.')

    expect(sendVerified).not.toHaveBeenCalled()
    expect(arm).not.toHaveBeenCalled()
  })
})
