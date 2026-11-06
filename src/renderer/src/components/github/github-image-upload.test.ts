// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { captureGitHubImageUpload } from './github-image-upload'
const { rpc, revision } = vi.hoisted(() => ({ rpc: vi.fn(), revision: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: revision
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => false }))
beforeEach(() => {
  vi.resetAllMocks()
  revision.mockReturnValue(4)
})
it('keeps every staged-byte request on the destination captured before the first await', async () => {
  const held = Promise.withResolvers<{ capabilities: string[] }>()
  rpc.mockImplementation(async (_runtime, method) => {
    if (method === 'status.get') {
      return held.promise
    }
    if (method === 'clipboard.startImageUpload') {
      return { uploadId: 'image-1' }
    }
    if (method === 'github.uploadAttachment') {
      return { url: 'https://github.com/user-attachments/assets/a' }
    }
    return {}
  })
  const address = {
    runtime: { kind: 'environment' as const, environmentId: 'owner' },
    target: { kind: 'repo' as const, repo: 'repo-1', source: 'origin' as const }
  }
  const upload = captureGitHubImageUpload(address)
  const result = upload(new File([new Uint8Array([0, 1, 255])], 'a.png', { type: 'image/png' }))
  address.runtime.environmentId = 'other'
  address.target.repo = 'repo-2'
  revision.mockReturnValue(9)
  held.resolve({ capabilities: ['github.image-attachments.v1'] })
  await expect(result).resolves.toBe('https://github.com/user-attachments/assets/a')
  for (const [runtime, , , options] of rpc.mock.calls) {
    expect(runtime).toEqual({ kind: 'environment', environmentId: 'owner' })
    expect(options.expectedEnvironmentPairingRevision).toBe(4)
  }
  expect(
    rpc.mock.calls.find((call) => call[1] === 'clipboard.appendImageUploadChunk')?.[2]
  ).toEqual({ uploadId: 'image-1', offset: 0, contentBase64: 'AAH/' })
  expect(rpc.mock.calls.find((call) => call[1] === 'github.uploadAttachment')?.[2]).toEqual({
    uploadId: 'image-1',
    target: { kind: 'repo', repo: 'repo-1', source: 'origin' },
    fileName: 'a.png',
    contentType: 'image/png'
  })
})
it('refuses image intake on an older runtime before sending any bytes', async () => {
  rpc.mockResolvedValue({ capabilities: [] })
  await expect(
    captureGitHubImageUpload({
      runtime: { kind: 'local' },
      target: {
        kind: 'repo',
        repo: 'repo-1',
        source: 'issue'
      }
    })(new File(['a'], 'a.png', { type: 'image/png' }))
  ).rejects.toThrow('cannot upload images yet')
  expect(rpc.mock.calls.map((call) => call[1])).toEqual(['status.get'])
})
