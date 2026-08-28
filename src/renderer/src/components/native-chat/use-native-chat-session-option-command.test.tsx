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

function renderDispatch(
  agent: 'codex' | 'claude' | 'openclaude',
  onSlashCommand?: (command: string, settled?: Promise<void>) => void
) {
  return renderHook(() =>
    useNativeChatSessionOptionCommand({
      agent,
      disabled: false,
      resolveTarget: () => ({ settings: {}, ptyId: 'pty-1' }),
      setHistory: vi.fn(),
      ...(onSlashCommand ? { onSlashCommand } : {})
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

  it('hands the report a settle signal that is still unresolved when it fires', async () => {
    // A handler that switches views unmounts this composer. Reporting a signal
    // that has already settled would be the same as reporting none, and the
    // unmount would land while the model-switch observer is still awaited.
    let race: string | null = null
    const onSlashCommand = vi.fn((_command: string, settled?: Promise<void>) => {
      // An already-resolved sentinel wins the race unless `settled` is resolved too.
      void Promise.race([settled!.then(() => 'settled'), Promise.resolve('pending')]).then(
        (winner) => {
          race = winner
        }
      )
    })
    const hook = renderDispatch('claude', onSlashCommand)
    await act(() => hook.result.current.dispatch('/model sonnet'))

    expect(onSlashCommand).toHaveBeenCalledWith('/model sonnet', expect.any(Promise))
    expect(race).toBe('pending')
  })
})
