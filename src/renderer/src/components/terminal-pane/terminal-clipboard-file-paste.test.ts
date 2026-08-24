import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'

const { pasteNativeTerminalFileDropMock } = vi.hoisted(() => ({
  pasteNativeTerminalFileDropMock: vi.fn(async () => true)
}))

vi.mock('./terminal-native-file-drop', () => ({
  pasteNativeTerminalFileDrop: pasteNativeTerminalFileDropMock
}))

import { pasteTerminalClipboardFilePaths } from './terminal-clipboard-file-paste'

describe('pasteTerminalClipboardFilePaths', () => {
  beforeEach(() => {
    pasteNativeTerminalFileDropMock.mockReset()
    pasteNativeTerminalFileDropMock.mockResolvedValue(true)
  })

  it('routes clipboard files through the native drop owner pipeline', async () => {
    const manager = {} as never
    const pane = { id: 7, leafId: 'leaf-7' } as never
    const paneTransports = new Map([[7, {} as never]])

    await expect(
      pasteTerminalClipboardFilePaths({
        manager,
        pane,
        paneTransports,
        paths: ['/Users/me/a file.txt'],
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        cwd: '/repo'
      })
    ).resolves.toBe(true)

    expect(pasteNativeTerminalFileDropMock).toHaveBeenCalledWith({
      manager,
      paneTransports,
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      cwd: '/repo',
      data: {
        paths: ['/Users/me/a file.txt'],
        target: NATIVE_FILE_DROP_TARGET.terminal,
        tabId: 'tab-1',
        paneLeafId: 'leaf-7'
      }
    })
  })

  it('rejects stale targets before starting file resolution', async () => {
    await expect(
      pasteTerminalClipboardFilePaths({
        manager: null,
        pane: { id: 7, leafId: 'leaf-7' } as never,
        paneTransports: new Map(),
        paths: ['/tmp/a.txt'],
        tabId: 'tab-1',
        worktreeId: 'worktree-1'
      })
    ).resolves.toBe(false)

    expect(pasteNativeTerminalFileDropMock).not.toHaveBeenCalled()
  })

  it('rejects the clipboard paste when the native drop writes no path', async () => {
    pasteNativeTerminalFileDropMock.mockResolvedValue(false)

    await expect(
      pasteTerminalClipboardFilePaths({
        manager: {} as never,
        pane: { id: 7, leafId: 'leaf-7' } as never,
        paneTransports: new Map([[7, {} as never]]),
        paths: ['/tmp/a.txt'],
        tabId: 'tab-1',
        worktreeId: 'worktree-1'
      })
    ).resolves.toBe(false)
  })
})
