import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import type { DocPreviewGrantLocation } from '@/lib/doc-preview-grants'
import {
  buildDocPreviewShareControl,
  readDocPreviewArtifactRequest
} from './doc-preview-artifact-share'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn(), readFile: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

const FILE_PATH = '/srv/repo/reports/latency.html'

const pairedLocation: DocPreviewGrantLocation = {
  owner: {
    kind: 'runtime',
    environmentId: 'server-1',
    worktreeSelector: 'id:repo::/srv/repo',
    worktreeRoot: '/srv/repo'
  },
  requestBase: '/srv/repo',
  root: '/srv/repo/reports',
  entryRelativePath: 'reports/latency.html'
}

const sshLocation: DocPreviewGrantLocation = {
  owner: { kind: 'ssh', connectionId: 'ssh-1' },
  requestBase: '/srv/repo',
  root: '/srv/repo/reports',
  entryRelativePath: 'reports/latency.html'
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { fs: { readFile: mocks.readFile } } })
})

describe('document preview sharing', () => {
  it('reads the page from the server its grant was minted for', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ content: '<h1>Latency</h1>', isBinary: false })

    await expect(
      readDocPreviewArtifactRequest(pairedLocation, FILE_PATH, 'key-1')
    ).resolves.toEqual({
      sourceKey: 'key-1',
      content: '<h1>Latency</h1>',
      contentType: 'text/html',
      fileName: 'latency.html'
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'files.readPreview',
      { worktree: 'id:repo::/srv/repo', relativePath: 'reports/latency.html' },
      expect.anything()
    )
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  // Why: a read without the connection id would share a local file instead.
  it('keeps an SSH grant on its connection, so the read fails closed', async () => {
    mocks.readFile.mockRejectedValue(new Error('SSH host is not served here'))

    await expect(readDocPreviewArtifactRequest(sshLocation, FILE_PATH, 'key-1')).rejects.toEqual(
      new ArtifactPublishPreparationError('unreadable')
    )
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith({
      filePath: FILE_PATH,
      connectionId: 'ssh-1'
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('refuses binary content and unreachable servers', async () => {
    mocks.callRuntimeRpc.mockResolvedValueOnce({ content: '', isBinary: true })
    await expect(readDocPreviewArtifactRequest(pairedLocation, FILE_PATH, 'key-1')).rejects.toEqual(
      new ArtifactPublishPreparationError('binary')
    )

    mocks.callRuntimeRpc.mockRejectedValueOnce(new Error('offline'))
    await expect(readDocPreviewArtifactRequest(pairedLocation, FILE_PATH, 'key-1')).rejects.toEqual(
      new ArtifactPublishPreparationError('unreadable')
    )
  })

  it('offers Share only for HTML previews with a minted grant', () => {
    expect(buildDocPreviewShareControl(FILE_PATH, pairedLocation)).toBeTypeOf('function')
    expect(buildDocPreviewShareControl(FILE_PATH, null)).toBeUndefined()
    expect(buildDocPreviewShareControl('/srv/repo/report.pdf', pairedLocation)).toBeUndefined()
  })
})
