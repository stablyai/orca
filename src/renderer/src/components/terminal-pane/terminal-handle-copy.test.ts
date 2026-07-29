import { describe, expect, it, vi } from 'vitest'
import { copyTerminalHandleForPane } from './terminal-handle-copy'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const ENVIRONMENT_ID = '23306b4a-670b-4e09-a1f7-85a0a7b17fe9'

function resolvedPane(handle: string): unknown {
  return {
    terminal: {
      handle,
      tabId: 'tab-1',
      leafId: LEAF_ID,
      ptyId: 'pty-1'
    }
  }
}

describe('copyTerminalHandleForPane', () => {
  it('copies the runtime terminal handle for a pane key', async () => {
    const callRuntime = vi.fn().mockResolvedValue(resolvedPane('term_worker'))
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await expect(
      copyTerminalHandleForPane({
        tabId: 'tab-1',
        leafId: LEAF_ID,
        callRuntime,
        writeClipboardText
      })
    ).resolves.toBe('term_worker')

    expect(callRuntime).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.resolvePane', {
      paneKey: `tab-1:${LEAF_ID}`
    })
    expect(writeClipboardText).toHaveBeenCalledWith('term_worker')
  })

  it('resolves against the owning runtime for a paired-environment pane', async () => {
    const callRuntime = vi.fn().mockResolvedValue(resolvedPane('term_remote'))
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await expect(
      copyTerminalHandleForPane({
        tabId: 'tab-1',
        leafId: LEAF_ID,
        runtimeEnvironmentId: ENVIRONMENT_ID,
        callRuntime,
        writeClipboardText
      })
    ).resolves.toBe('term_remote')

    expect(callRuntime).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENVIRONMENT_ID },
      'terminal.resolvePane',
      { paneKey: `tab-1:${LEAF_ID}` }
    )
    expect(writeClipboardText).toHaveBeenCalledWith('term_remote')
  })

  it('treats a blank environment id as the local runtime', async () => {
    const callRuntime = vi.fn().mockResolvedValue(resolvedPane('term_worker'))
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await copyTerminalHandleForPane({
      tabId: 'tab-1',
      leafId: LEAF_ID,
      runtimeEnvironmentId: '   ',
      callRuntime,
      writeClipboardText
    })

    expect(callRuntime).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.resolvePane',
      expect.anything()
    )
  })

  it('surfaces runtime lookup failures without writing the clipboard', async () => {
    const callRuntime = vi.fn().mockRejectedValue(new Error('terminal not found'))
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

  it('rejects when the runtime resolves a pane without a handle', async () => {
    const callRuntime = vi.fn().mockResolvedValue({ terminal: { tabId: 'tab-1' } })
    const writeClipboardText = vi.fn()

    await expect(
      copyTerminalHandleForPane({
        tabId: 'tab-1',
        leafId: LEAF_ID,
        callRuntime,
        writeClipboardText
      })
    ).rejects.toThrow('Terminal ID unavailable')

    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
