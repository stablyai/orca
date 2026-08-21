import { describe, expect, it, vi } from 'vitest'
import { copyTerminalHandleForPane, copyTerminalHandleForPaneKey } from './terminal-handle-copy'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

describe('copyTerminalHandleForPane', () => {
  it('copies the runtime terminal handle for a pane key', async () => {
    const callRuntime = vi.fn().mockResolvedValue({
      id: 'req-1',
      ok: true,
      result: {
        terminal: {
          handle: 'term_worker',
          tabId: 'tab-1',
          leafId: LEAF_ID,
          ptyId: 'pty-1'
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await expect(
      copyTerminalHandleForPane({
        tabId: 'tab-1',
        leafId: LEAF_ID,
        callRuntime,
        writeClipboardText
      })
    ).resolves.toBe('term_worker')

    expect(callRuntime).toHaveBeenCalledWith({
      method: 'terminal.resolvePane',
      params: { paneKey: PANE_KEY }
    })
    expect(writeClipboardText).toHaveBeenCalledWith('term_worker')
  })

  it('surfaces runtime lookup failures without writing the clipboard', async () => {
    const callRuntime = vi.fn().mockResolvedValue({
      id: 'req-1',
      ok: false,
      error: {
        code: 'terminal_not_found',
        message: 'terminal not found'
      }
    })
    const writeClipboardText = vi.fn()

    await expect(
      copyTerminalHandleForPane({
        tabId: 'tab-1',
        leafId: LEAF_ID,
        callRuntime,
        writeClipboardText
      })
    ).rejects.toThrow('terminal not found')

    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})

describe('copyTerminalHandleForPaneKey', () => {
  it('parses paneKey and copies the resolved terminal handle', async () => {
    const callRuntime = vi.fn().mockResolvedValue({
      id: 'req-1',
      ok: true,
      result: {
        terminal: {
          handle: 'term_sidebar_agent',
          tabId: 'tab-1',
          leafId: LEAF_ID,
          ptyId: 'pty-1'
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await expect(
      copyTerminalHandleForPaneKey({
        paneKey: PANE_KEY,
        callRuntime,
        writeClipboardText
      })
    ).resolves.toBe('term_sidebar_agent')

    expect(callRuntime).toHaveBeenCalledWith({
      method: 'terminal.resolvePane',
      params: { paneKey: PANE_KEY }
    })
    expect(writeClipboardText).toHaveBeenCalledWith('term_sidebar_agent')
  })

  it('rejects invalid pane keys without calling the runtime', async () => {
    const callRuntime = vi.fn()
    const writeClipboardText = vi.fn()

    await expect(
      copyTerminalHandleForPaneKey({
        paneKey: 'tab-1:not-a-uuid',
        callRuntime,
        writeClipboardText
      })
    ).rejects.toThrow('Terminal ID unavailable')

    expect(callRuntime).not.toHaveBeenCalled()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
