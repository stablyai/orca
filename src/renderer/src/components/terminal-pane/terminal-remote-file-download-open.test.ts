import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ download: vi.fn(async () => ({ canceled: true })) }))
vi.mock('@/runtime/runtime-file-client', () => ({ downloadRuntimeFile: mocks.download }))
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'

afterEach(() => vi.unstubAllGlobals())
it('downloads a nested SSH file through its runtime instead of a same-ID desktop SSH target', async () => {
  const nativeDownload = vi.fn(async () => ({ canceled: true }))
  vi.stubGlobal('window', { api: { fs: { downloadFile: nativeDownload } } })
  const context = {
    settings: { activeRuntimeEnvironmentId: 'remote' },
    connectionId: 'same-id',
    worktreeId: 'folder',
    worktreePath: '/workspace'
  }
  await downloadAndOpenRemoteTerminalFile(context, '/workspace/report.pdf')
  expect(mocks.download).toHaveBeenCalledWith(context, '/workspace/report.pdf', 'report.pdf')
  expect(nativeDownload).not.toHaveBeenCalled()
})
