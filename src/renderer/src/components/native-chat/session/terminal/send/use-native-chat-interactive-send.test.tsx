// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../../../../../../shared/agent-status/lifecycle/agent-interrupt-intent'

const mocks = vi.hoisted(() => ({
  inferInterrupt: vi.fn(() => Promise.resolve(true)),
  inferQuestionAnswered: vi.fn(() => Promise.resolve(true)),
  sendRuntimePtyInputVerified: vi.fn((..._args: unknown[]) => Promise.resolve(true))
}))

vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: (...args: unknown[]) => mocks.sendRuntimePtyInputVerified(...args)
}))

import { useAppStore } from '../../../../../store/index'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const initialState = useAppStore.getInitialState()

function workingStatus(prompt: string, startedAt: number): AgentStatusEntry {
  return {
    state: 'working',
    prompt,
    updatedAt: startedAt,
    stateStartedAt: startedAt,
    agentType: 'openclaude',
    paneKey: PANE_KEY,
    stateHistory: []
  }
}

describe('useNativeChatInteractiveSend Stop interrupt inference', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    vi.clearAllMocks()
    useAppStore.setState(initialState, true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentStatus: {
          inferQuestionAnswered: mocks.inferQuestionAnswered,
          inferInterrupt: mocks.inferInterrupt
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
  })

  // A slow remote acceptance must not settle a turn that started after the Stop.
  it('infers a Stop from the status before its Escape, not a turn that began mid-send', async () => {
    const startedAt = 10_000
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: workingStatus('run sleep 60', startedAt) }
    })
    let accept: (accepted: boolean) => void = () => {}
    mocks.sendRuntimePtyInputVerified.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        accept = resolve
      })
    )
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend(PANE_KEY, 'pty-1', 'openclaude')
    )

    act(() => result.current.cancel())
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: workingStatus('next prompt', startedAt + 1) }
    })
    await act(async () => accept(true))
    await act(async () => {
      vi.advanceTimersByTime(AGENT_INTERRUPT_SETTLE_MS)
    })

    expect(mocks.inferInterrupt).not.toHaveBeenCalled()
  })
})
