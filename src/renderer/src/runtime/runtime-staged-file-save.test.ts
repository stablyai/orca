import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STAGED_FILE_SAVE_CHUNK_BYTES,
  STAGED_FILE_SAVE_RUNTIME_CAPABILITY
} from '../../../shared/staged-file-save'

type RecordedCall = { method: string; params: Record<string, unknown> }
const rpc = vi.hoisted(
  (): {
    capabilities: string[]
    calls: RecordedCall[]
    failOn: string | null
    generation: number
  } => ({ capabilities: [], calls: [], failOn: null, generation: 1 })
)
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(
    async (
      _target: unknown,
      method: string,
      params: Record<string, unknown>,
      options: { beforeSend?: () => void }
    ) => {
      options.beforeSend?.()
      rpc.calls.push({ method, params })
      if (method === rpc.failOn) {
        throw new Error('connection lost')
      }
      return { ok: true }
    }
  )
}))
vi.mock('./runtime-file-mutation-rpc', () => ({
  RuntimeConnectionChangedError: class extends Error {},
  callRuntimeFileMutationWithCapabilities: vi.fn(
    async (
      _target: unknown,
      method: string,
      plan: (capabilities: string[]) => Promise<{ params: Record<string, unknown> }>
    ) => {
      const planned = await plan(rpc.capabilities)
      rpc.calls.push({ method, params: planned.params })
      return { saveId: 'save-1' }
    }
  )
}))
vi.mock('./runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => 1
}))
vi.mock('@/store/slices/runtime-status', () => ({
  getRuntimeEnvironmentConnectionGeneration: () => rpc.generation
}))

import { writeRemoteFileStaged } from './runtime-staged-file-save'

const target = { kind: 'environment' as const, environmentId: 'env-1' }
const location = { worktree: 'id:wt-1', relativePath: 'package-lock.json' }
const content = 'x'.repeat(STAGED_FILE_SAVE_CHUNK_BYTES * 2 + 10)
const precondition = { expectedSignature: 'sig' }

beforeEach(() => {
  rpc.capabilities = [STAGED_FILE_SAVE_RUNTIME_CAPABILITY]
  rpc.calls = []
  rpc.failOn = null
  rpc.generation = 1
})

describe('a staged remote save', () => {
  it('sends the content in order in chunks, then commits under the precondition', async () => {
    const beforeSend = vi.fn()
    await expect(
      writeRemoteFileStaged(
        target,
        location,
        content,
        precondition,
        () => new Error('big'),
        beforeSend
      )
    ).resolves.toEqual({ ok: true })
    expect(rpc.calls.map(({ method }) => method)).toEqual([
      'files.saveBegin',
      'files.saveChunk',
      'files.saveChunk',
      'files.saveChunk',
      'files.saveCommit'
    ])
    expect(rpc.calls[0]?.params).toEqual({ ...location, totalBytes: content.length })
    expect(rpc.calls.slice(1, 4).map(({ params }) => params.offset)).toEqual([
      0,
      STAGED_FILE_SAVE_CHUNK_BYTES,
      STAGED_FILE_SAVE_CHUNK_BYTES * 2
    ])
    expect(rpc.calls[4]?.params).toEqual({ saveId: 'save-1', diskPrecondition: precondition })
    expect(beforeSend).toHaveBeenCalledOnce()
  })

  it("keeps today's refusal on a host that can't take a staged save, sending nothing", async () => {
    rpc.capabilities = []
    await expect(
      writeRemoteFileStaged(target, location, content, precondition, () => new Error('too large'))
    ).rejects.toThrow('too large')
    expect(rpc.calls).toEqual([])
  })

  it('aborts the save on the host when a chunk fails', async () => {
    rpc.failOn = 'files.saveChunk'
    await expect(
      writeRemoteFileStaged(target, location, content, undefined, () => new Error('big'))
    ).rejects.toThrow('connection lost')
    await vi.waitFor(() =>
      expect(rpc.calls.at(-1)).toEqual({ method: 'files.saveAbort', params: { saveId: 'save-1' } })
    )
  })
})
