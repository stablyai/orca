// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { searchRuntimeRepoBaseRefDetails, searchRuntimeRepoBaseRefs } from './runtime-repo-client'

const searchBaseRefs = vi.fn()
const searchBaseRefDetails = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  searchBaseRefs.mockReset()
  searchBaseRefDetails.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: {
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
