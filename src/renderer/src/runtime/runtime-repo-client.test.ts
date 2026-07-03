// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from './runtime-rpc-client'
import {
  createRuntimeRepoInitialCommit,
  searchRuntimeRepoBaseRefDetails,
  searchRuntimeRepoBaseRefs
} from './runtime-repo-client'

const createInitialCommit = vi.fn()
const searchBaseRefs = vi.fn()
const searchBaseRefDetails = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  createInitialCommit.mockReset()
  searchBaseRefs.mockReset()
  searchBaseRefDetails.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: {
        createInitialCommit,
        searchBaseRefs,
        searchBaseRefDetails
      },
      runtimeEnvironments: {
        call: runtimeCall
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createRuntimeRepoInitialCommit', () => {
  it('routes local runtime targets through preload IPC', async () => {
    createInitialCommit.mockResolvedValue({ ok: true, baseRef: 'main' })

    await expect(createRuntimeRepoInitialCommit(null, 'repo-1')).resolves.toEqual({
      ok: true,
      baseRef: 'main'
    })

    expect(createInitialCommit).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('routes environment runtime targets through repo.createInitialCommit RPC', async () => {
    markRuntimeEnvironmentCompatible('env-1')
    runtimeCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { ok: true, baseRef: 'trunk' },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      createRuntimeRepoInitialCommit({ activeRuntimeEnvironmentId: 'env-1' }, 'repo-1')
    ).resolves.toEqual({ ok: true, baseRef: 'trunk' })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.createInitialCommit',
      params: { repo: 'repo-1' },
      timeoutMs: 15_000
    })
    expect(createInitialCommit).not.toHaveBeenCalled()
  })
})

describe('runtime repo client search bounds', () => {
  it('rejects oversized local base-ref searches before IPC', async () => {
    await expect(
      searchRuntimeRepoBaseRefs(null, 'repo-1', 'x'.repeat(3 * 1024), 20)
    ).resolves.toEqual([])

    expect(searchBaseRefs).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('rejects oversized runtime base-ref detail searches before RPC', async () => {
    await expect(
      searchRuntimeRepoBaseRefDetails(
        { activeRuntimeEnvironmentId: 'env-1' },
        'repo-1',
        'secret-token-value'.repeat(256),
        20
      )
    ).resolves.toEqual([])

    expect(searchBaseRefDetails).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
