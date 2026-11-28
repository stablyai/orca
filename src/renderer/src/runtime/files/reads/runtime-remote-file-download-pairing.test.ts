import { describe, expect, it } from 'vitest'
import { downloadRemoteRuntimeFile } from './runtime-remote-file-download'
import {
  fsAppendDownloadedFileChunk,
  fsCancelDownloadedFile,
  fsFinishDownloadedFile,
  fsSaveDownloadedFile,
  fsStartDownloadedFile,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  type RuntimeRpcRequest
} from '../runtime-file-client-test-harness'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'

installRuntimeFileClientEnvironment()

const remoteArgs = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'repo-1::/repo',
  worktreeSelector: 'id:repo-1::/repo',
  relativePath: 'scene.blend'
}

const ok = (result: unknown): unknown => ({
  id: 'rpc',
  ok: true,
  result,
  _meta: { runtimeId: 'remote-runtime' }
})

const PAIRING_REFUSED = {
  id: 'rpc',
  ok: false,
  error: {
    code: 'runtime_environment_changed',
    message: 'Runtime environment pairing changed; refresh and try again'
  },
  _meta: { runtimeId: 'remote-runtime' }
}

function chunkReply(offset: number, length: number, total: number): unknown {
  const size = Math.min(length, total - offset)
  return ok({
    contentBase64: Buffer.alloc(size, 7).toString('base64'),
    bytesRead: size,
    eof: offset + size >= total
  })
}

function chunkParams(request: RuntimeRpcRequest): { offset: number; length: number } {
  const params: unknown = request.params
  if (
    typeof params === 'object' &&
    params !== null &&
    'offset' in params &&
    'length' in params &&
    typeof params.offset === 'number' &&
    typeof params.length === 'number'
  ) {
    return { offset: params.offset, length: params.length }
  }
  throw new Error(`expected chunk params, got ${JSON.stringify(params)}`)
}

function publishPairing(revision: number): void {
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: revision }])
}

// One download must come from one host: probe, every page and the preview fallback stay pinned to
// the pairing captured at the click, so a mid-transfer re-pair fails the transfer instead of mixing bytes.
// The host double mirrors main's guard: a pinned call answers only while its pairing is still registered.
describe('paired download pins its pairing revision', () => {
  it('carries the click-time revision through probe and every chunk after a re-pair', async () => {
    publishPairing(11)
    fsStartDownloadedFile.mockResolvedValue({
      canceled: false,
      transferId: 't1',
      destinationPath: '/downloads/scene.blend'
    })
    fsAppendDownloadedFileChunk.mockResolvedValue({ ok: true })
    fsFinishDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/scene.blend'
    })
    fsCancelDownloadedFile.mockResolvedValue({ ok: true })
    const total = 384 * 1024 + 10
    const fileCalls: RuntimeRpcRequest[] = []
    let repaired = false
    runtimeEnvironmentCall.mockImplementation((request: RuntimeRpcRequest) => {
      fileCalls.push(request)
      const params = chunkParams(request)
      const isPage = request.method === 'files.readChunk' && params.length > 1
      if (isPage && !repaired) {
        // The user re-pairs the same environment id while the first page is in flight.
        repaired = true
        publishPairing(12)
      }
      const stale =
        request.expectedEnvironmentPairingRevision !== undefined &&
        request.expectedEnvironmentPairingRevision !== (repaired ? 12 : 11)
      return Promise.resolve(
        stale ? PAIRING_REFUSED : chunkReply(params.offset, params.length, total)
      )
    })

    await expect(downloadRemoteRuntimeFile(remoteArgs, 'scene.blend')).rejects.toThrow(
      'pairing changed'
    )
    expect(fileCalls.length).toBeGreaterThan(1)
    for (const call of fileCalls) {
      expect(call.expectedEnvironmentPairingRevision).toBe(11)
    }
    expect(fsFinishDownloadedFile).not.toHaveBeenCalled()
    expect(fsCancelDownloadedFile).toHaveBeenCalledWith({ transferId: 't1' })
  })

  it('pins the preview fallback for hosts without chunk downloads', async () => {
    publishPairing(11)
    fsSaveDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/scene.blend'
    })
    const fileCalls: RuntimeRpcRequest[] = []
    let repaired = false
    runtimeEnvironmentCall.mockImplementation((request: RuntimeRpcRequest) => {
      fileCalls.push(request)
      if (request.method === 'files.readChunk') {
        return Promise.resolve({
          id: 'rpc',
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method: files.readChunk' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      // The re-pair lands between the probe and the preview read.
      repaired = true
      publishPairing(12)
      const stale =
        request.expectedEnvironmentPairingRevision !== undefined &&
        request.expectedEnvironmentPairingRevision !== (repaired ? 12 : 11)
      return Promise.resolve(
        stale
          ? PAIRING_REFUSED
          : ok({
              content: Buffer.alloc(4, 7).toString('base64'),
              isBinary: true,
              mimeType: 'x/blender'
            })
      )
    })

    await expect(downloadRemoteRuntimeFile(remoteArgs, 'scene.blend')).rejects.toThrow(
      'pairing changed'
    )
    expect(fileCalls.map((call) => call.method)).toEqual(['files.readChunk', 'files.readPreview'])
    for (const call of fileCalls) {
      expect(call.expectedEnvironmentPairingRevision).toBe(11)
    }
    expect(fsSaveDownloadedFile).not.toHaveBeenCalled()
  })
})
