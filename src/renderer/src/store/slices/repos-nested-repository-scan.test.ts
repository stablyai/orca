import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const scanNested = vi.fn()
const cancelNestedScan = vi.fn()
const onNestedScanProgress = vi.fn()
const runtimeCall = vi.fn()
const runtimeTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  onNestedScanProgress.mockReturnValue(vi.fn())
  runtimeTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      projectGroups: { scanNested, cancelNestedScan, onNestedScanProgress },
      runtimeEnvironments: { call: runtimeTransportCall }
    }
  })
})

describe('nested repository scan store routing', () => {
  it('routes local progress by scanId and unsubscribes after completion', async () => {
    const unsubscribe = vi.fn()
    const progressCallback = vi.fn()
    const matchingScan: NestedRepoScanResult = {
      selectedPath: '/platform',
      selectedPathKind: 'non_git_folder',
      repos: [{ path: '/platform/api', displayName: 'api', depth: 1 }],
      truncated: false,
      timedOut: false,
      stopped: false,
      durationMs: 10,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: null
    }
    onNestedScanProgress.mockImplementation(
      (listener: (data: { scanId: string; scan: NestedRepoScanResult }) => void) => {
        listener({ scanId: 'other-scan', scan: { ...matchingScan, repos: [] } })
        listener({ scanId: 'scan-1', scan: matchingScan })
        return unsubscribe
      }
    )
    scanNested.mockResolvedValue(matchingScan)
    const store = createTestStore()

    await expect(
      store.getState().scanNestedRepos('/platform', undefined, {
        scanId: 'scan-1',
        onProgress: progressCallback
      })
    ).resolves.toEqual(matchingScan)

    expect(progressCallback).toHaveBeenCalledExactlyOnceWith(matchingScan)
    expect(scanNested).toHaveBeenCalledWith({
      path: '/platform',
      connectionId: undefined,
      scanId: 'scan-1'
    })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes local progress when the scan rejects', async () => {
    const unsubscribe = vi.fn()
    onNestedScanProgress.mockReturnValue(unsubscribe)
    scanNested.mockRejectedValue(new Error('scan failed'))
    const store = createTestStore()

    await expect(
      store.getState().scanNestedRepos('/platform', undefined, {
        scanId: 'scan-1',
        onProgress: vi.fn()
      })
    ).resolves.toBeNull()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('cancels local scans through the preload API', async () => {
    cancelNestedScan.mockResolvedValue(true)
    const store = createTestStore()

    await expect(store.getState().cancelNestedRepoScan('scan-1')).resolves.toBe(true)

    expect(cancelNestedScan).toHaveBeenCalledWith({ scanId: 'scan-1' })
  })

  it('does not send cancellation to a runtime environment', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await expect(store.getState().cancelNestedRepoScan('scan-1')).resolves.toBe(false)

    expect(cancelNestedScan).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('normalizes older runtime results and keeps the RPC bounded', async () => {
    runtimeCall.mockResolvedValue({
      id: 'rpc-scan',
      ok: true,
      result: {
        selectedPath: '/platform',
        selectedPathKind: 'non_git_folder',
        repos: [{ path: '/platform/api', displayName: 'api', depth: 1 }],
        truncated: true,
        timedOut: false,
        durationMs: 10,
        maxDepth: 3
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-ambient' } as never })

    await expect(
      store.getState().scanNestedRepos('/platform', undefined, {
        runtimeEnvironmentId: 'env-selected'
      })
    ).resolves.toMatchObject({ stopped: false, maxRepos: 100, timeoutMs: null })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-selected',
      method: 'projectGroup.scanNested',
      params: { path: '/platform' },
      timeoutMs: 20_000
    })
  })

  it('routes explicit Git-root traversal to paired runtimes', async () => {
    runtimeCall.mockResolvedValue({
      id: 'rpc-scan',
      ok: true,
      result: {
        selectedPath: '/platform',
        selectedPathKind: 'git_repo',
        repos: [],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 1,
        maxDepth: 3,
        maxRepos: 100,
        timeoutMs: 15_000
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()

    await store.getState().scanNestedRepos('/platform', undefined, {
      runtimeEnvironmentId: 'env-selected',
      traverseGitRoot: true
    })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-selected',
      method: 'projectGroup.scanNested',
      params: { path: '/platform', options: { traverseGitRoot: true } },
      timeoutMs: 20_000
    })
  })
})
