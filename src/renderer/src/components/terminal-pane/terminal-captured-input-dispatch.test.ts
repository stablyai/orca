import { describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport'
import {
  requestCapturedTerminalReconfirmation,
  sendCapturedTerminalInput
} from './terminal-captured-input-dispatch'

function createTransport(ptyId: string | null, sendResult = true): PtyTransport {
  return {
    getPtyId: vi.fn(() => ptyId),
    sendInput: vi.fn(() => sendResult)
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

  it('runs the accepted callback only after a successful captured send', () => {
    const transport = createTransport('pty-original')
    const onAccepted = vi.fn()

    expect(
      sendCapturedTerminalInput({
        targetPaneMounted: true,
        currentTransport: transport,
        capturedTransport: transport,
        capturedPtyId: 'pty-original',
        data: '\x1b[13;2u',
        onAccepted
      })
    ).toBe(true)

    expect(onAccepted).toHaveBeenCalledOnce()
  })

  it('does not run the accepted callback for a rejected captured send', () => {
    const transport = createTransport('pty-original', false)
    const onAccepted = vi.fn()

    expect(
      sendCapturedTerminalInput({
        targetPaneMounted: true,
        currentTransport: transport,
        capturedTransport: transport,
        capturedPtyId: 'pty-original',
        data: '\x1b[13;2u',
        onAccepted
      })
    ).toBe(false)

    expect(onAccepted).not.toHaveBeenCalled()
  })

  it.each(['local IPC', 'SSH remote runtime'])(
    'does not deliver to a replacement %s transport for a reused pane',
    () => {
      const original = createTransport('pty-original')
      const replacement = createTransport('pty-replacement')
      const onAccepted = vi.fn()

      expect(
        sendCapturedTerminalInput({
          targetPaneMounted: true,
          currentTransport: replacement,
          capturedTransport: original,
          capturedPtyId: 'pty-original',
          data: '\r',
          onAccepted
        })
      ).toBe(false)
      expect(original.sendInput).not.toHaveBeenCalled()
      expect(replacement.sendInput).not.toHaveBeenCalled()
      expect(onAccepted).not.toHaveBeenCalled()
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
    const requestWindowsShiftEnterReconfirmation = vi.fn()
    const binding = { requestWindowsShiftEnterReconfirmation }

    requestCapturedTerminalReconfirmation(binding, binding)

    expect(requestWindowsShiftEnterReconfirmation).toHaveBeenCalledOnce()
  })

  it('does not call a disposed binding or its replacement', () => {
    const original = { requestWindowsShiftEnterReconfirmation: vi.fn() }
    const replacement = { requestWindowsShiftEnterReconfirmation: vi.fn() }

    requestCapturedTerminalReconfirmation(replacement, original)

    expect(original.requestWindowsShiftEnterReconfirmation).not.toHaveBeenCalled()
    expect(replacement.requestWindowsShiftEnterReconfirmation).not.toHaveBeenCalled()
  })
})
