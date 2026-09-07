import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileToOsClipboard, downloadRemoteFile } from './file-explorer-row-file-transfer'
import {
  shouldShowCollapseFolderAction,
  shouldShowFindInFolderAction,
  shouldShowCopyFileAction,
  shouldShowOpenInTerminalAction,
  shouldShowRemoteDownloadAction,
  shouldShowViewFileAction
} from './file-explorer-row-action-visibility'
import { directoryNode, fileNode } from './file-explorer-tree-node-test-fixtures'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'

const { downloadRuntimeFileMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  downloadRuntimeFileMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock
  }
}))

vi.mock('@/runtime/runtime-file-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileClient>()
  return {
    ...actual,
    downloadRuntimeFile: downloadRuntimeFileMock
  }
})

function setDownloadPlatform(platform: NodeJS.Platform): void {
  ;(
    window as unknown as {
      api: { platform: { get: () => { platform: NodeJS.Platform } } }
    }
  ).api.platform = { get: () => ({ platform }) }
}

beforeEach(() => {
  toastErrorMock.mockReset()
  toastSuccessMock.mockReset()
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
})

describe('FileExplorerRow collapse folder action', () => {
  it('only shows collapse folder for expanded directories', () => {
    expect(shouldShowCollapseFolderAction(directoryNode, true)).toBe(true)
    expect(shouldShowCollapseFolderAction(directoryNode, false)).toBe(false)
    expect(
      shouldShowCollapseFolderAction(
        {
          ...directoryNode,
          name: 'index.ts',
          path: '/repo/src/index.ts',
          relativePath: 'src/index.ts',
          isDirectory: false
        },
        true
      )
    ).toBe(false)
  })

  it('only shows find in folder for directories', () => {
    expect(shouldShowFindInFolderAction(directoryNode)).toBe(true)
    expect(
      shouldShowFindInFolderAction({
        ...directoryNode,
        name: 'index.ts',
        path: '/repo/src/index.ts',
        relativePath: 'src/index.ts',
        isDirectory: false
      })
    ).toBe(false)
  })

  it('only shows open in terminal for directories', () => {
    expect(shouldShowOpenInTerminalAction(directoryNode)).toBe(true)
    expect(shouldShowOpenInTerminalAction(fileNode)).toBe(false)
  })

  it('only shows view file for files', () => {
    expect(shouldShowViewFileAction(fileNode)).toBe(true)
    expect(shouldShowViewFileAction(directoryNode)).toBe(false)
  })

  it('shows remote download only for desktop SSH rows and file-like Remote Host rows', () => {
    const runtimeContext = {
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    }

    expect(shouldShowRemoteDownloadAction(fileNode, 'ssh-1')).toBe(true)
    expect(shouldShowRemoteDownloadAction({ ...fileNode, isSymlink: true }, 'ssh-1')).toBe(true)
    expect(shouldShowRemoteDownloadAction(fileNode, null, runtimeContext)).toBe(true)
    expect(shouldShowRemoteDownloadAction(fileNode, null)).toBe(false)
    // Why: directory download defaults fail-closed until the connection advertises
    // supportsFolderDownload (SFTP); system-SSH and unknown capability stay hidden.
    expect(shouldShowRemoteDownloadAction(directoryNode, 'ssh-1')).toBe(false)
    expect(shouldShowRemoteDownloadAction(directoryNode, 'ssh-1', null, true)).toBe(true)
    expect(shouldShowRemoteDownloadAction(directoryNode, 'ssh-1', null, false)).toBe(false)
    expect(shouldShowRemoteDownloadAction(fileNode, 'ssh-1', null, false)).toBe(true)
    expect(shouldShowRemoteDownloadAction(directoryNode, null, runtimeContext)).toBe(false)

    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true

    expect(shouldShowRemoteDownloadAction(fileNode, 'ssh-1')).toBe(false)
    expect(shouldShowRemoteDownloadAction(fileNode, null, runtimeContext)).toBe(false)
  })

  it('shows OS file copy for single local rows and SSH file rows on desktop', () => {
    const previous = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    try {
      expect(shouldShowCopyFileAction(fileNode, null, 1)).toBe(true)
      expect(shouldShowCopyFileAction(directoryNode, null, 1)).toBe(true)
      expect(shouldShowCopyFileAction(fileNode, undefined, 2)).toBe(false)
      expect(shouldShowCopyFileAction(fileNode, 'ssh-1', 1)).toBe(true)
      expect(shouldShowCopyFileAction(directoryNode, 'ssh-1', 1)).toBe(false)

      ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true

      expect(shouldShowCopyFileAction(fileNode, null, 1)).toBe(false)
    } finally {
      ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = previous
    }
  })

  it('copies local and SSH file rows through the clipboard file API', async () => {
    const writeClipboardFile = vi.fn().mockResolvedValue({ ok: true })
    ;(
      globalThis as unknown as {
        window: { api: { ui: { writeClipboardFile: typeof writeClipboardFile } } }
      }
    ).window = { api: { ui: { writeClipboardFile } } }

    await copyFileToOsClipboard(fileNode)
    await copyFileToOsClipboard(fileNode, 'ssh-1')

    expect(writeClipboardFile).toHaveBeenNthCalledWith(1, '/repo/src/index.ts')
    expect(writeClipboardFile).toHaveBeenNthCalledWith(2, {
      filePath: '/repo/src/index.ts',
      connectionId: 'ssh-1'
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('shows a failure toast when OS file copy fails', async () => {
    const writeClipboardFile = vi.fn().mockResolvedValue({ ok: false, reason: 'invalid-path' })
    ;(
      globalThis as unknown as {
        window: { api: { ui: { writeClipboardFile: typeof writeClipboardFile } } }
      }
    ).window = { api: { ui: { writeClipboardFile } } }

    await copyFileToOsClipboard(fileNode)

    expect(toastErrorMock).toHaveBeenCalledWith('Could not copy the file to the clipboard')
  })

  it('shows an actionable toast when remote clipboard staging is unavailable', async () => {
    const writeClipboardFile = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'staging-unavailable'
    })
    ;(
      globalThis as unknown as {
        window: { api: { ui: { writeClipboardFile: typeof writeClipboardFile } } }
      }
    ).window = { api: { ui: { writeClipboardFile } } }

    await copyFileToOsClipboard(fileNode, 'ssh-1')

    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not copy the file because Orca's temporary storage is unavailable"
    )
  })

  it('shows the remote copy rejection message when SSH materialization fails', async () => {
    const writeClipboardFile = vi.fn().mockRejectedValue(new Error('Remote connection dropped'))
    ;(
      globalThis as unknown as {
        window: { api: { ui: { writeClipboardFile: typeof writeClipboardFile } } }
      }
    ).window = { api: { ui: { writeClipboardFile } } }

    await copyFileToOsClipboard(fileNode, 'ssh-1')

    expect(toastErrorMock).toHaveBeenCalledWith('Remote connection dropped')
  })

  it('calls the preload download API and shows success only when not canceled', async () => {
    const downloadFile = vi
      .fn()
      .mockResolvedValueOnce({
        canceled: false,
        destinationPath: '/downloads/renamed\\entry.ts'
      })
      .mockResolvedValueOnce({ canceled: true })
    const openPath = vi.fn().mockResolvedValue(undefined)
    ;(
      globalThis as unknown as {
        window: {
          api: {
            fs: { downloadFile: typeof downloadFile }
            shell: { openPath: typeof openPath }
          }
        }
      }
    ).window = { api: { fs: { downloadFile }, shell: { openPath } } }
    setDownloadPlatform('linux')

    await downloadRemoteFile(fileNode, 'ssh-1')
    await downloadRemoteFile(fileNode, 'ssh-1')

    expect(downloadFile).toHaveBeenCalledWith({
      filePath: '/repo/src/index.ts',
      connectionId: 'ssh-1'
    })
    expect(toastSuccessMock).toHaveBeenCalledTimes(1)
    expect(toastSuccessMock).toHaveBeenCalledWith("Downloaded 'renamed\\entry.ts'", {
      action: {
        label: 'Open',
        onClick: expect.any(Function)
      }
    })
    const action = toastSuccessMock.mock.calls[0]?.[1]?.action as
      | { onClick: () => void }
      | undefined
    action?.onClick()
    expect(openPath).toHaveBeenCalledWith('/downloads/renamed\\entry.ts')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('reports the saved folder name from a Windows destination path', async () => {
    const downloadFolder = vi.fn().mockResolvedValue({
      canceled: false,
      destinationPath: 'C:\\Users\\dev\\Downloads\\src-copy'
    })
    ;(
      globalThis as unknown as {
        window: { api: { fs: { downloadFolder: typeof downloadFolder } } }
      }
    ).window = { api: { fs: { downloadFolder } } }
    setDownloadPlatform('win32')

    await downloadRemoteFile(directoryNode, 'ssh-1')

    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Downloaded folder 'src-copy'",
      expect.objectContaining({ action: expect.anything() })
    )
  })

  it('calls the preload folder download API for SSH directory rows', async () => {
    const downloadFolder = vi.fn().mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/src'
    })
    const openPath = vi.fn().mockResolvedValue(undefined)
    ;(
      globalThis as unknown as {
        window: {
          api: {
            fs: { downloadFolder: typeof downloadFolder }
            shell: { openPath: typeof openPath }
          }
        }
      }
    ).window = { api: { fs: { downloadFolder }, shell: { openPath } } }
    setDownloadPlatform('linux')

    await downloadRemoteFile(directoryNode, 'ssh-1')

    expect(downloadFolder).toHaveBeenCalledWith({
      dirPath: '/repo/src',
      connectionId: 'ssh-1'
    })
    expect(toastSuccessMock).toHaveBeenCalledWith("Downloaded folder 'src'", {
      action: {
        label: 'Open',
        onClick: expect.any(Function)
      }
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('downloads Remote Host rows through the runtime download path', async () => {
    const runtimeContext = {
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    }
    downloadRuntimeFileMock.mockResolvedValueOnce({
      canceled: false,
      destinationPath: '/downloads/index.ts'
    })
    const openPath = vi.fn().mockResolvedValue(undefined)
    ;(
      globalThis as unknown as {
        window: {
          api: {
            shell: { openPath: typeof openPath }
          }
        }
      }
    ).window = { api: { shell: { openPath } } }
    setDownloadPlatform('linux')

    await downloadRemoteFile(fileNode, runtimeContext)

    expect(downloadRuntimeFileMock).toHaveBeenCalledWith(
      runtimeContext,
      '/repo/src/index.ts',
      'index.ts'
    )
    expect(toastSuccessMock).toHaveBeenCalledWith("Downloaded 'index.ts'", {
      action: {
        label: 'Open',
        onClick: expect.any(Function)
      }
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('shows a failure toast when remote download fails', async () => {
    const downloadFile = vi.fn().mockRejectedValue(new Error('Remote connection dropped'))
    ;(
      globalThis as unknown as { window: { api: { fs: { downloadFile: typeof downloadFile } } } }
    ).window = { api: { fs: { downloadFile } } }

    await downloadRemoteFile(fileNode, 'ssh-1')

    expect(toastErrorMock).toHaveBeenCalledWith('Remote connection dropped')
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})
