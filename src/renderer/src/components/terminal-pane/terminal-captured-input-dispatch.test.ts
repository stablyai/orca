import { describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport'
import {
  requestCapturedTerminalReconfirmation,
  sendCapturedTerminalInput
} from './terminal-captured-input-dispatch'

function createTransport(ptyId: string | null): PtyTransport {
  return {
    getPtyId: vi.fn(() => ptyId),
    sendInput: vi.fn(() => true)
  } as unknown as PtyTransport
}

describe('sendCapturedTerminalInput', () => {
  it.each(['local IPC', 'SSH remote runtime'])(
    'sends on the captured %s route while its PTY still owns the mounted pane',
    () => {
      const transport = createTransport('pty-original')

      expect(
        sendCapturedTerminalInput({
          targetPaneMounted: true,
          currentTransport: transport,
          capturedTransport: transport,
          capturedPtyId: 'pty-original',
          data: '\r'
        })
      ).toBe(true)
      expect(transport.sendInput).toHaveBeenCalledWith('\r')
    }
  )

  it.each(['local IPC', 'SSH remote runtime'])(
    'does not deliver to a replacement %s transport for a reused pane',
    () => {
      const original = createTransport('pty-original')
      const replacement = createTransport('pty-replacement')

      expect(
        sendCapturedTerminalInput({
          targetPaneMounted: true,
          currentTransport: replacement,
          capturedTransport: original,
          capturedPtyId: 'pty-original',
          data: '\r'
        })
      ).toBe(false)
      expect(original.sendInput).not.toHaveBeenCalled()
      expect(replacement.sendInput).not.toHaveBeenCalled()
    }
  )

  it('does not deliver after the captured transport rebinds to another PTY', () => {
    const transport = createTransport('pty-replacement')

    expect(
      sendCapturedTerminalInput({
        targetPaneMounted: true,
        currentTransport: transport,
        capturedTransport: transport,
        capturedPtyId: 'pty-original',
        data: '\r'
      })
    ).toBe(false)
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('does not deliver after pane disposal', () => {
    const transport = createTransport('pty-original')

    expect(
      sendCapturedTerminalInput({
        targetPaneMounted: false,
        currentTransport: undefined,
        capturedTransport: transport,
        capturedPtyId: 'pty-original',
        data: '\r'
      })
    ).toBe(false)
    expect(transport.sendInput).not.toHaveBeenCalled()
  })
})

describe('requestCapturedTerminalReconfirmation', () => {
  it('reconfirms only through the still-current captured binding', () => {
    const requestDroidReconfirmation = vi.fn()
    const binding = { requestDroidReconfirmation }

    requestCapturedTerminalReconfirmation(binding, binding)

    expect(requestDroidReconfirmation).toHaveBeenCalledOnce()
  })

  it('does not call a disposed binding or its replacement', () => {
    const original = { requestDroidReconfirmation: vi.fn() }
    const replacement = { requestDroidReconfirmation: vi.fn() }

    requestCapturedTerminalReconfirmation(replacement, original)

    expect(original.requestDroidReconfirmation).not.toHaveBeenCalled()
    expect(replacement.requestDroidReconfirmation).not.toHaveBeenCalled()
  })
})
