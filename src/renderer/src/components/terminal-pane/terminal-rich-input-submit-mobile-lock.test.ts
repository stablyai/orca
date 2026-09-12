import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import type { PtyTransport } from './pty-transport'
import { submitTerminalRichInput } from './terminal-rich-input-submit'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-bracketed-paste'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from './terminal-paste-coordinator'

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('./terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: vi.fn() }))

const ptyIds = ['pty-local', 'pty-ssh', 'remote:pty-runtime']
afterEach(() => {
  for (const ptyId of ptyIds) {
    setDriverForPty(ptyId, { kind: 'idle' })
  }
})

function harness(ptyId = ptyIds[0]!) {
  const lock = (): void => setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
  const terminal = {
    input: vi.fn(),
    paste: vi.fn(),
    scrollToBottom: vi.fn(),
    modes: { bracketedPasteMode: true },
    options: { ignoreBracketedPasteMode: false }
  }
  const pane = { id: 1, leafId: 'leaf-1', terminal } as unknown as ManagedPane
  const sendInputAccepted = vi.fn(async (_data: string) => true)
  const transport = {
    getPtyId: () => ptyId,
    getConnectionId: () => (ptyId === 'pty-ssh' ? 'ssh-1' : null),
    isConnected: () => true,
    sendInputAccepted
  } as unknown as PtyTransport
  const args = {
    text: 'prompt',
    tabId: 'tab-1',
    worktreeId: 'folder-workspace',
    pane,
    transport,
    getManager: () => ({ getPanes: () => [pane] }) as unknown as PaneManager,
    getPaneTransports: () => new Map([[pane.id, transport]]),
    delay: async (_milliseconds: number) => {}
  }
  return { args, terminal, sendInputAccepted, lock }
}

const longText = 'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES + 10)

describe('rich-input mobile ownership during submission', () => {
  it.each(ptyIds)(
    'stops chunked writes and bracket cleanup on lock acquisition: %s',
    async (ptyId) => {
      const { args, lock, terminal, sendInputAccepted } = harness(ptyId)
      sendInputAccepted.mockImplementation(async (data) => {
        if (data !== BRACKETED_PASTE_START) {
          lock()
        }
        return true
      })
      await expect(submitTerminalRichInput({ ...args, text: longText })).resolves.toEqual({
        status: 'not-started'
      })
      expect(sendInputAccepted).toHaveBeenCalledTimes(2)
      expect(sendInputAccepted).toHaveBeenNthCalledWith(1, BRACKETED_PASTE_START)
      expect(sendInputAccepted).not.toHaveBeenCalledWith(BRACKETED_PASTE_END)
      expect(terminal.input).not.toHaveBeenCalled()
      expect(terminal.paste).not.toHaveBeenCalled()
    }
  )

  it.each(['prompt', longText])(
    'rechecks ownership inside the deferred write (%#. case)',
    async (text) => {
      const { args, lock, terminal, sendInputAccepted } = harness()
      const getManager = () => {
        queueMicrotask(lock)
        return args.getManager()
      }
      await expect(submitTerminalRichInput({ ...args, text, getManager })).resolves.toEqual({
        status: 'not-started'
      })
      expect(sendInputAccepted).not.toHaveBeenCalled()
      expect(terminal.paste).not.toHaveBeenCalled()
      expect(terminal.input).not.toHaveBeenCalled()
    }
  )

  it('does not begin attachments when the PTY is already mobile-owned', async () => {
    const { args, lock, terminal } = harness()
    lock()
    await expect(
      submitTerminalRichInput({ ...args, imagePaths: ['/host/first.png'] })
    ).resolves.toEqual({ status: 'not-started' })
    expect(terminal.input).not.toHaveBeenCalled()
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('stops before the next attachment and reports only the completed image for reconciliation', async () => {
    const { args, lock, terminal } = harness()
    terminal.input.mockImplementationOnce(lock)
    await expect(
      submitTerminalRichInput({ ...args, imagePaths: ['/host/first.png', '/host/second.png'] })
    ).resolves.toEqual({ status: 'partially-written', imagePathsWritten: 1, textWritten: false })
    expect(terminal.input).toHaveBeenCalledExactlyOnceWith(
      `${BRACKETED_PASTE_START}/host/first.png${BRACKETED_PASTE_END}`
    )
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('does not paste text after ownership changes during image settling', async () => {
    const { args, lock, terminal } = harness()
    await expect(
      submitTerminalRichInput({
        ...args,
        imagePaths: ['/host/first.png'],
        delay: async () => lock()
      })
    ).resolves.toEqual({ status: 'partially-written', imagePathsWritten: 1, textWritten: false })
    expect(terminal.input).toHaveBeenCalledTimes(1)
    expect(terminal.input).not.toHaveBeenCalledWith('\r')
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('does not send Enter after a mobile takeover during the delivery wait', async () => {
    const { args, lock, terminal } = harness()
    await expect(submitTerminalRichInput({ ...args, delay: async () => lock() })).resolves.toEqual({
      status: 'partially-written',
      imagePathsWritten: 0,
      textWritten: true
    })
    expect(terminal.paste).toHaveBeenCalledExactlyOnceWith('prompt')
    expect(terminal.input).not.toHaveBeenCalled()
    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
  })

  it('preserves unlocked attachment, chunked text and Enter ordering', async () => {
    const { args, terminal, sendInputAccepted } = harness()
    await expect(
      submitTerminalRichInput({ ...args, text: longText, imagePaths: ['/host/first.png'] })
    ).resolves.toEqual({ status: 'submitted', deliveryConfirmed: false })
    expect(sendInputAccepted.mock.calls.map(([data]) => data).join('')).toBe(
      `${BRACKETED_PASTE_START}${longText}${BRACKETED_PASTE_END}`
    )
    expect(terminal.input.mock.calls).toEqual([
      [`${BRACKETED_PASTE_START}/host/first.png${BRACKETED_PASTE_END}`],
      ['\r']
    ])
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce()
  })
})
