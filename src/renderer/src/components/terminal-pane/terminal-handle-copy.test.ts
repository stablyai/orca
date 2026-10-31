import { describe, expect, it, vi } from 'vitest'
import { copyTerminalHandleForPane } from './terminal-handle-copy'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('copyTerminalHandleForPane', () => {
  it('copies the owning server handle for a paired-server pane without asking this runtime', async () => {
    // Why: this desktop's runtime has no record of a server-owned pane (#11664, #15553).
    const callRuntime = vi.fn().mockResolvedValue({
      id: 'req-1',
      ok: false,
      error: { code: 'terminal_not_found', message: 'terminal not found' }
    })
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await expect(
      copyTerminalHandleForPane({
        tabId: 'tab-1',
        leafId: LEAF_ID,
        ptyId: toRemoteRuntimePtyId('term_on_server', 'env-1'),
        callRuntime,
        writeClipboardText
      })
    ).resolves.toBe('term_on_server')

    expect(callRuntime).not.toHaveBeenCalled()
    expect(writeClipboardText).toHaveBeenCalledWith('term_on_server')
  })

  it('refuses an unreadable paired-server pty instead of asking this runtime', async () => {
    const callRuntime = vi.fn()
    const writeClipboardText = vi.fn()

    await expect(
      copyTerminalHandleForPane({
        tabId: 'tab-1',
        leafId: LEAF_ID,
        ptyId: 'remote:',
        callRuntime,
        writeClipboardText
      })
    ).rejects.toThrow('Terminal ID unavailable')

    expect(callRuntime).not.toHaveBeenCalled()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
