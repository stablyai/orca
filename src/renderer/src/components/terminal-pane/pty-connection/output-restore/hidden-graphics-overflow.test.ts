import { describe, expect, it, vi } from 'vitest'
import {
  announceMainDrop,
  connectVisiblePane,
  installHiddenRestoreFloodSuiteHooks,
  PTY_ID
} from '../test-fixtures/pty-connection-test-hidden-restore-flood'

vi.mock('@/lib/pane-manager/terminal-rendering/pane-inline-images', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  terminalHasStoredInlineImages: () => true
}))

describe('hidden graphics after output loss', () => {
  installHiddenRestoreFloodSuiteHooks(true)

  it('downgrades the pending-cap owner and replies once to the sentinel and in-flight query', async () => {
    const drive = await connectVisiblePane()
    try {
      drive.setVisible(false)
      drive.disposable.syncProcessTracking()
      expect(window.api.pty.setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, true, true)

      await announceMainDrop(undefined, undefined, 'unhide')
      const before = drive.writtenChunks()
      drive.transport.getPtyId.mockReturnValue('replacement-pty')
      await announceMainDrop(30, undefined, 'pending-cap')
      expect(drive.writtenChunks()).toEqual(before)
      drive.transport.getPtyId.mockReturnValue(PTY_ID)
      drive.deliver('continuous', 10)
      expect(window.api.pty.setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, true, true)

      await announceMainDrop(30, undefined, 'pending-cap')
      drive.deliver('\x1b[6n', undefined, { droppedOutput: true })
      drive.deliver('after the cap\x1b[', 45)
      drive.deliver('6n', 47)

      expect(drive.transport.sendInputImmediate.mock.calls).toEqual([['\x1b[1;1R'], ['\x1b[1;1R']])
      expect(window.api.pty.setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, true)
    } finally {
      drive.disposable.dispose()
    }
  })

  it('releases the claim when the renderer queue really overflows', async () => {
    const drive = await connectVisiblePane()
    try {
      drive.setVisible(false)
      drive.disposable.syncProcessTracking()
      const burst = `${'x'.repeat(2 * 1024 * 1024 + 1)}\x1b[6n`
      drive.deliver(burst, burst.length)
      drive.deliver('\x1b[6n', burst.length + 4)

      expect(drive.transport.sendInputImmediate.mock.calls).toEqual([['\x1b[1;1R'], ['\x1b[1;1R']])
      expect(window.api.pty.setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, true)
    } finally {
      drive.disposable.dispose()
    }
  })
})
