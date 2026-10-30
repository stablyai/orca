import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_BYTES_SAVE_UPDATE_REQUIRED_MESSAGE,
  FILE_BYTES_WRITE_CHUNK_BYTES,
  FILE_REPLACE_WITH_UPLOAD_RUNTIME_CAPABILITY
} from '../../../shared/file-bytes-write'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'

const calls = vi.hoisted(() => {
  const state: {
    capabilities: string[]
    sent: { method: string; params: Record<string, unknown> }[]
    replaceResult: unknown
  } = { capabilities: [], sent: [], replaceResult: { ok: true } }
  return state
})
vi.mock('./runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => 7
}))
vi.mock('./runtime-file-mutation-rpc', () => ({
  callRuntimeFileMutationWithCapabilities: async (
    _target: unknown,
    method: string,
    plan: (capabilities: string[]) => Promise<{ params: Record<string, unknown> }>
  ) => {
    const planned = await plan(calls.capabilities)
    calls.sent.push({ method, params: planned.params })
  },
  callRuntimeFileMutation: async (
    _target: unknown,
    method: string,
    params: Record<string, unknown>,
    _timeout: number,
    _pairing: number,
    beforeSend?: () => void
  ) => {
    beforeSend?.()
    calls.sent.push({ method, params })
    return method === 'files.replaceWithUpload' ? calls.replaceResult : { ok: true }
  }
}))

import { writeRuntimeFileBytes } from './runtime-file-bytes-write'

// An SSH-hosted worktree served by the remote Orca server: the same runtime route.
const context: RuntimeFileOperationArgs = {
  target: { kind: 'environment', environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/srv/repo',
  expectedExecutionHostId: 'ssh:box'
}
const precondition = { expectedSha256: 'a'.repeat(64), allowMissing: true }

beforeEach(() => {
  calls.capabilities = [FILE_REPLACE_WITH_UPLOAD_RUNTIME_CAPABILITY]
  calls.sent = []
  calls.replaceResult = { ok: true }
})

describe('writeRuntimeFileBytes on a remote host', () => {
  it('uploads chunks beside the file, then swaps them in under the baseline hash', async () => {
    const bytes = new Uint8Array(FILE_BYTES_WRITE_CHUNK_BYTES + 3).fill(0xfe)
    const beforeSend = vi.fn()
    await expect(
      writeRuntimeFileBytes(
        context,
        '/srv/repo/data/book.xlsx',
        bytes,
        undefined,
        precondition,
        beforeSend
      )
    ).resolves.toEqual({ ok: true })
    const [first, second, replace] = calls.sent
    expect(first.method).toBe('files.writeBase64Chunk')
    expect(first.params).toMatchObject({ append: false })
    expect(String(first.params.relativePath)).toMatch(/^data\/\.book\.xlsx\.orca-save-/)
    expect(second.params).toMatchObject({ append: true, relativePath: first.params.relativePath })
    expect(atob(String(second.params.contentBase64))).toHaveLength(3)
    expect(replace).toMatchObject({
      method: 'files.replaceWithUpload',
      params: {
        expectedExecutionHostId: 'ssh:box',
        tempRelativePath: first.params.relativePath,
        finalRelativePath: 'data/book.xlsx',
        bytesPrecondition: precondition
      }
    })
    expect(beforeSend).toHaveBeenCalledOnce()
  })

  it('refuses before writing anything when the host cannot swap binary files', async () => {
    calls.capabilities = []
    await expect(
      writeRuntimeFileBytes(
        context,
        '/srv/repo/book.xlsx',
        new Uint8Array([1]),
        undefined,
        precondition
      )
    ).rejects.toThrow(FILE_BYTES_SAVE_UPDATE_REQUIRED_MESSAGE)
    expect(calls.sent.map((call) => call.method)).toEqual(['files.delete'])
  })

  it('reports a stale baseline from the host as a conflict', async () => {
    calls.replaceResult = { ok: false, diskConflict: 'changed' }
    await expect(
      writeRuntimeFileBytes(
        context,
        '/srv/repo/book.xlsx',
        new Uint8Array([1]),
        undefined,
        precondition
      )
    ).resolves.toEqual({ ok: false, diskConflict: 'changed' })
  })
})
