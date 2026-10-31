import { describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport-types'
import { sendCapturedTerminalInput } from './terminal-captured-input-dispatch'

function createTransport(ptyId: string | null, sendResult = true): PtyTransport {
  return {
    getPtyId: vi.fn(() => ptyId),
    sendInput: vi.fn(() => sendResult)
  } as unknown as PtyTransport
}

describe('sendCapturedTerminalInput', () => {
  it('does not deliver to a replacement transport for a reused pane', () => {
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
  })

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
