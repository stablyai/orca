// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false
}))

import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'

describe('useNativeChatPickerCommandDispatch', () => {
  it('blocks duplicates and preserves composer state when verified delivery is rejected', async () => {
    let settleDelivery!: (delivered: boolean) => void
    const handle = {
      cancel: vi.fn(),
      settleAfterMs: 500,
      delivered: new Promise<boolean>((resolve) => {
        settleDelivery = resolve
      })
    }
    sendNativeChatTypedCommand.mockReturnValue(handle)
    const setDraft = vi.fn()
    const setNotice = vi.fn()
    const setVerifiedSendPending = vi.fn()
    const onSlashCommand = vi.fn()
    const args = {
      agent: 'codex' as const,
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: () => ({
        ptyId: 'pty-1',
        settings: {},
        writer: {
          requiresWriteAcceptance: true,
          write: vi.fn(() => true),
          writeAccepted: vi.fn(async () => false)
        }
      }),
      onSlashCommand,
      sessionOptionsSurface: null,
      trackPendingSend: vi.fn(),
      setHistory: vi.fn(),
      setDraft,
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice,
      setVerifiedSendPending
    }
    const { result } = renderHook(() => useNativeChatPickerCommandDispatch(args))
    const command = {
      kind: 'command' as const,
      id: 'command:clear',
      name: 'clear',
      skillCollision: false
    }

    act(() => {
      result.current(command)
      result.current(command)
    })

    expect(sendNativeChatTypedCommand).toHaveBeenCalledOnce()
    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith(
      {},
      'pty-1',
      '/clear',
      expect.any(Object)
    )
    expect(setVerifiedSendPending).toHaveBeenCalledWith(true)
    expect(setDraft).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalled()

    await act(async () => settleDelivery(false))

    expect(setVerifiedSendPending).toHaveBeenLastCalledWith(false)
    expect(setNotice).toHaveBeenCalledWith(expect.stringMatching(/did not accept/))
    expect(setDraft).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalled()
  })
})
