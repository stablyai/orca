import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'

const mocks = vi.hoisted(() => ({
  pasteTextIntoTerminalPane: vi.fn(),
  recordTerminalUserInputForLeaf: vi.fn()
}))

vi.mock('./terminal-programmatic-text-paste', () => ({
  pasteTextIntoTerminalPane: mocks.pasteTextIntoTerminalPane
}))
vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

import {
  TERMINAL_RICH_INPUT_IMAGE_SETTLE_MS,
  TERMINAL_RICH_INPUT_SUBMIT_DELAY_MS,
  submitTerminalRichInput
} from './terminal-rich-input-submit'

function makePane() {
  return {
    id: 1,
    leafId: 'leaf-1',
    terminal: { input: vi.fn(), scrollToBottom: vi.fn() }
  } as unknown as ManagedPane
}

function makeTransport(ptyId = 'pty-1') {
  return {
    getPtyId: vi.fn(() => ptyId),
    isConnected: vi.fn(() => true)
  } as unknown as PtyTransport
}

describe('terminal rich input submit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pasteTextIntoTerminalPane.mockResolvedValue(true)
  })

  it('pastes, waits, and submits to the same live leaf', async () => {
    const pane = makePane()
    const transport = makeTransport()
    const panes = new Map([[pane.id, transport]])
    const delay = vi.fn(async () => {})

    await expect(
      submitTerminalRichInput({
        text: 'first\nsecond',
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        pane,
        transport,
        getManager: () => ({ getPanes: () => [pane] }) as unknown as PaneManager,
        getPaneTransports: () => panes,
        delay
      })
    ).resolves.toEqual({ status: 'submitted', deliveryConfirmed: false })

    expect(delay).toHaveBeenCalledWith(TERMINAL_RICH_INPUT_SUBMIT_DELAY_MS)
    expect(pane.terminal.input).toHaveBeenCalledWith('\r')
    expect(pane.terminal.scrollToBottom).toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('pastes image attachments before the prompt and waits for each stage', async () => {
    const pane = makePane()
    const transport = makeTransport()
    const panes = new Map([[pane.id, transport]])
    const delay = vi.fn(async () => {})

    await expect(
      submitTerminalRichInput({
        text: 'review this image',
        imagePaths: ['/tmp/orca-paste-image.png'],
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        pane,
        transport,
        getManager: () => ({ getPanes: () => [pane] }) as unknown as PaneManager,
        getPaneTransports: () => panes,
        delay
      })
    ).resolves.toEqual({ status: 'submitted', deliveryConfirmed: false })

    expect(mocks.pasteTextIntoTerminalPane).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: '/tmp/orca-paste-image.png',
        forceBracketedPaste: true
      })
    )
    expect(mocks.pasteTextIntoTerminalPane).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'review this image' })
    )
    expect(delay).toHaveBeenNthCalledWith(1, TERMINAL_RICH_INPUT_IMAGE_SETTLE_MS)
    expect(delay).toHaveBeenNthCalledWith(2, TERMINAL_RICH_INPUT_SUBMIT_DELAY_MS)
  })

  it('reports exactly which stages were written before a later paste failed', async () => {
    mocks.pasteTextIntoTerminalPane.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const pane = makePane()
    const transport = makeTransport()

    await expect(
      submitTerminalRichInput({
        text: 'review both',
        imagePaths: ['/tmp/first.png'],
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        pane,
        transport,
        getManager: () => ({ getPanes: () => [pane] }) as unknown as PaneManager,
        getPaneTransports: () => new Map([[pane.id, transport]]),
        delay: vi.fn(async () => {})
      })
    ).resolves.toEqual({
      status: 'partially-written',
      imagePathsWritten: 1,
      textWritten: false
    })
    expect(pane.terminal.input).not.toHaveBeenCalled()
  })

  it('does not report submission when the transport disconnects during the final delay', async () => {
    const pane = makePane()
    const transport = makeTransport()
    const panes = new Map([[pane.id, transport]])
    const delay = async () => {
      vi.mocked(transport.isConnected).mockReturnValue(false)
    }

    await expect(
      submitTerminalRichInput({
        text: 'hello',
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        pane,
        transport,
        getManager: () => ({ getPanes: () => [pane] }) as unknown as PaneManager,
        getPaneTransports: () => panes,
        delay
      })
    ).resolves.toEqual({
      status: 'partially-written',
      imagePathsWritten: 0,
      textWritten: true
    })

    expect(pane.terminal.input).not.toHaveBeenCalled()
  })

  it('does not send Enter after the leaf changes PTY ownership', async () => {
    const pane = makePane()
    const originalTransport = makeTransport('pty-1')
    const replacementTransport = makeTransport('pty-2')
    const panes = new Map([[pane.id, originalTransport]])
    const delay = async () => {
      panes.set(pane.id, replacementTransport)
    }

    await expect(
      submitTerminalRichInput({
        text: 'hello',
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        pane,
        transport: originalTransport,
        getManager: () => ({ getPanes: () => [pane] }) as unknown as PaneManager,
        getPaneTransports: () => panes,
        delay
      })
    ).resolves.toEqual({
      status: 'partially-written',
      imagePathsWritten: 0,
      textWritten: true
    })

    expect(pane.terminal.input).not.toHaveBeenCalled()
  })
})
