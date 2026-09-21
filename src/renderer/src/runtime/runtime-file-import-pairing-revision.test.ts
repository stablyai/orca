import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from './runtime-file-client'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

const ENVIRONMENT_ID = 'env-repaired'
const CAPTURED_REVISION = 41
const REPLACEMENT_REVISION = 42
const CAPTURED_CONNECTION_GENERATION = 7
const REPLACEMENT_CONNECTION_GENERATION = 8

type RuntimeCallArgs = {
  selector: string
  method: string
  params?: Record<string, unknown>
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

const runtimeEnvironmentCall = vi.fn<(args: RuntimeCallArgs) => unknown>()
const stageExternalPathsForRuntimeUpload = vi.fn()
const uploadExternalFileToRuntime = vi.fn<(args: Record<string, unknown>) => unknown>()
const importExternalPaths = vi.fn()

const nestedSshContext = {
  settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
  worktreeId: 'wt-nested-ssh',
  worktreePath: '/ssh/repo',
  connectionId: 'hub-ssh-1',
  expectedExecutionHostId: 'ssh:hub-ssh-1' as const,
  expectedSshTargetId: 'hub-ssh-1',
  expectedSshConnectionGeneration: 7
}

const hubLocalContext = {
  settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
  worktreeId: 'wt-hub-local',
  worktreePath: '/hub/repo',
  expectedExecutionHostId: 'local' as const
}

function setEnvironmentRevision(pairingRevision: number): void {
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision }])
}

function runtimeStatusResponse() {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'hub-runtime',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
    },
    _meta: { runtimeId: 'hub-runtime' }
  }
}

function successfulRuntimeResponse(method: string) {
  return {
    id: method,
    ok: true,
    result: { ok: true },
    _meta: { runtimeId: 'hub-runtime' }
  }
}

function missingRuntimePathResponse() {
  return {
    id: 'files.stat',
    ok: false,
    error: { code: 'not_found', message: 'not found' },
    _meta: { runtimeId: 'hub-runtime' }
  }
}

function repairedRuntimeResponse(method: string) {
  return {
    id: method,
    ok: false,
    error: {
      code: 'runtime_environment_repaired',
      message: 'Runtime environment was re-paired during the import.'
    },
    _meta: { runtimeId: 'replacement-hub-runtime' }
  }
}

/** Staging now hands over identity, not a body; the streamer in main reads the bytes. */
function mockStagedFile(sourcePath: string, name: string, byteLength: number): void {
  stageExternalPathsForRuntimeUpload.mockResolvedValue({
    sources: [
      {
        sourcePath,
        status: 'staged',
        name,
        kind: 'file',
        entries: [
          {
            relativePath: '',
            kind: 'file',
            byteLength,
            inode: 91,
            deviceId: 66,
            modifiedAtMs: 1_700_000_000_000
          }
        ]
      }
    ]
  })
}

function expectUploadsBoundToCapturedRevision(): void {
  for (const [args] of uploadExternalFileToRuntime.mock.calls) {
    expect(args.expectedEnvironmentPairingRevision).toBe(CAPTURED_REVISION)
    expect(args.expectedEnvironmentRuntimeId).toBe('hub-runtime')
  }
}

function expectEveryRuntimeCallBoundToCapturedRevision(ownership: {
  expectedExecutionHostId: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}): void {
  const calls = runtimeEnvironmentCall.mock.calls
  expect(calls.filter(([args]) => args.method === 'status.get')).toHaveLength(1)
  for (const [args] of calls) {
    expect(args.selector).toBe(ENVIRONMENT_ID)
    expect(args.expectedEnvironmentPairingRevision).toBe(CAPTURED_REVISION)
    if (args.method.startsWith('files.') && args.method !== 'files.stat') {
      expect(args.expectedEnvironmentRuntimeId).toBe('hub-runtime')
      expect(args.params).toMatchObject({
        expectedExecutionHostId: ownership.expectedExecutionHostId,
        ...(ownership.expectedSshTargetId
          ? { expectedSshTargetId: ownership.expectedSshTargetId }
          : {}),
        ...(ownership.expectedSshConnectionGeneration === undefined
          ? {}
          : { expectedSshConnectionGeneration: ownership.expectedSshConnectionGeneration })
      })
    }
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  setEnvironmentRevision(CAPTURED_REVISION)
  setRuntimeEnvironmentConnectionGenerationForTests(ENVIRONMENT_ID, CAPTURED_CONNECTION_GENERATION)
  markRuntimeEnvironmentCompatible(ENVIRONMENT_ID)
  runtimeEnvironmentCall.mockReset()
  stageExternalPathsForRuntimeUpload.mockReset()
  uploadExternalFileToRuntime.mockReset()
  uploadExternalFileToRuntime.mockResolvedValue({ byteLength: 0 })
  importExternalPaths.mockReset()
  vi.stubGlobal('window', {
    api: {
      fs: {
        importExternalPaths,
        stageExternalPathsForRuntimeUpload,
        uploadExternalFileToRuntime
      },
      runtimeEnvironments: {
        call: runtimeEnvironmentCall
      }
    }
  })
})

describe('runtime file import pairing revision', () => {
  it('rejects a runtime replacement published during the capability probe', async () => {
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeCallArgs) => {
      if (args.method === 'status.get') {
        setRuntimeEnvironmentConnectionGenerationForTests(
          ENVIRONMENT_ID,
          REPLACEMENT_CONNECTION_GENERATION
        )
        return runtimeStatusResponse()
      }
      return successfulRuntimeResponse(args.method)
    })

    await expect(
      importExternalPathsToRuntime(nestedSshContext, ['/client/drop.txt'], '/ssh/repo/uploads')
    ).rejects.toThrow('Runtime connection changed; retry the import.')

    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual(['status.get'])
    expect(stageExternalPathsForRuntimeUpload).not.toHaveBeenCalled()
    expectEveryRuntimeCallBoundToCapturedRevision(nestedSshContext)
  })

  it('stops when the HUB runtime changes without a pairing change', async () => {
    mockStagedFile('/client/screenshot.png', 'screenshot.png', 40 * 1024 * 1024)
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeCallArgs) => {
      if (args.method === 'status.get') {
        return runtimeStatusResponse()
      }
      if (args.method === 'files.stat') {
        return missingRuntimePathResponse()
      }
      return successfulRuntimeResponse(args.method)
    })
    uploadExternalFileToRuntime.mockImplementation(async () => {
      setRuntimeEnvironmentConnectionGenerationForTests(
        ENVIRONMENT_ID,
        REPLACEMENT_CONNECTION_GENERATION
      )
      return { byteLength: 40 * 1024 * 1024 }
    })

    await expect(
      importExternalPathsToRuntime(nestedSshContext, ['/client/screenshot.png'], '/ssh/repo')
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'Runtime connection changed; retry the import.' }]
    })

    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
      'status.get',
      'files.stat'
    ])
    expectUploadsBoundToCapturedRevision()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.delete' })
    )
    expectEveryRuntimeCallBoundToCapturedRevision(nestedSshContext)
  })

  it('stops a global drop when the same-id HUB is re-paired during staging', async () => {
    runtimeEnvironmentCall.mockResolvedValue(runtimeStatusResponse())
    stageExternalPathsForRuntimeUpload.mockImplementation(async () => {
      setEnvironmentRevision(REPLACEMENT_REVISION)
      return { sources: [] }
    })

    await expect(
      importExternalPathsToRuntime(nestedSshContext, ['/client/drop.txt'], '/ssh/repo/uploads')
    ).rejects.toThrow('Runtime pairing changed; retry the import.')

    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual(['status.get'])
    expectEveryRuntimeCallBoundToCapturedRevision(nestedSshContext)
    expect(importExternalPaths).not.toHaveBeenCalled()
  })

  it('never commits a streamed upload against a replacement HUB re-paired mid-stream', async () => {
    mockStagedFile('/client/screenshot.png', 'screenshot.png', 40 * 1024 * 1024)
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeCallArgs) => {
      if (args.method === 'status.get') {
        return runtimeStatusResponse()
      }
      if (args.method === 'files.stat') {
        return missingRuntimePathResponse()
      }
      return successfulRuntimeResponse(args.method)
    })
    uploadExternalFileToRuntime.mockImplementation(async () => {
      setEnvironmentRevision(REPLACEMENT_REVISION)
      return { byteLength: 40 * 1024 * 1024 }
    })

    await expect(
      importExternalPathsToRuntime(nestedSshContext, ['/client/screenshot.png'], '/ssh/repo')
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'Runtime pairing changed; retry the import.' }]
    })

    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
      'status.get',
      'files.stat'
    ])
    expectUploadsBoundToCapturedRevision()
    expectEveryRuntimeCallBoundToCapturedRevision(nestedSshContext)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.delete' })
    )
  })

  it('keeps a HUB-local composer commit on its entry revision when re-paired during commit', async () => {
    mockStagedFile('/client/note.txt', 'note.txt', 4)
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeCallArgs) => {
      if (args.expectedEnvironmentPairingRevision !== CAPTURED_REVISION) {
        throw new Error('replacement HUB received an import RPC')
      }
      if (args.method === 'status.get') {
        return runtimeStatusResponse()
      }
      if (args.method === 'files.stat') {
        return missingRuntimePathResponse()
      }
      if (args.method === 'files.commitUpload') {
        setEnvironmentRevision(REPLACEMENT_REVISION)
        return repairedRuntimeResponse(args.method)
      }
      return successfulRuntimeResponse(args.method)
    })

    await expect(
      importExternalPathsToRuntime(hubLocalContext, ['/client/note.txt'], '/hub/repo')
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'Runtime pairing changed; retry the import.' }]
    })

    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
      'status.get',
      'files.stat',
      'files.commitUpload'
    ])
    expectEveryRuntimeCallBoundToCapturedRevision(hubLocalContext)
  })

  it('does not clean up against a replacement HUB after commit', async () => {
    mockStagedFile('/client/drop.txt', 'drop.txt', 4)
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeCallArgs) => {
      if (args.method === 'status.get') {
        return runtimeStatusResponse()
      }
      if (args.method === 'files.stat') {
        return missingRuntimePathResponse()
      }
      if (args.method === 'files.commitUpload') {
        setEnvironmentRevision(REPLACEMENT_REVISION)
      }
      return successfulRuntimeResponse(args.method)
    })

    await expect(
      importExternalPathsToRuntime(nestedSshContext, ['/client/drop.txt'], '/ssh/repo')
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'Runtime pairing changed; retry the import.' }]
    })

    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
      'status.get',
      'files.stat',
      'files.commitUpload'
    ])
    expectEveryRuntimeCallBoundToCapturedRevision(nestedSshContext)
  })

  it('uses the captured revision for temp cleanup and directory rollback', async () => {
    stageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/client/assets',
          status: 'staged',
          name: 'assets',
          kind: 'directory',
          entries: [
            { relativePath: '', kind: 'directory' },
            {
              relativePath: 'broken.txt',
              kind: 'file',
              byteLength: 6,
              inode: 92,
              deviceId: 66,
              modifiedAtMs: 1_700_000_000_000
            }
          ]
        }
      ]
    })
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeCallArgs) => {
      if (args.method === 'status.get') {
        return runtimeStatusResponse()
      }
      if (args.method === 'files.stat') {
        return missingRuntimePathResponse()
      }
      return successfulRuntimeResponse(args.method)
    })
    uploadExternalFileToRuntime.mockRejectedValue(new Error('disk full'))

    await expect(
      importExternalPathsToRuntime(nestedSshContext, ['/client/assets'], '/ssh/repo')
    ).resolves.toMatchObject({ results: [{ status: 'failed', reason: 'disk full' }] })

    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
      'status.get',
      'files.stat',
      'files.createDirNoClobber',
      'files.delete',
      'files.delete'
    ])
    const deleteCalls = runtimeEnvironmentCall.mock.calls
      .map(([args]) => args as RuntimeCallArgs)
      .filter((args) => args.method === 'files.delete')
    expect(deleteCalls).toHaveLength(2)
    expect(deleteCalls.map((args) => args.params?.recursive)).toEqual([false, true])
    expect(deleteCalls[0]?.params?.relativePath).toMatch(/^assets\/\.broken\.txt\.orca-upload-/)
    expect(deleteCalls[1]?.params?.relativePath).toBe('assets')
    expectEveryRuntimeCallBoundToCapturedRevision(nestedSshContext)
  })
})
