// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefDetails,
  searchRuntimeRepoBaseRefs
} from './runtime-repo-client'

const getBaseRefDefault = vi.fn()
const searchBaseRefs = vi.fn()
const searchBaseRefDetails = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  getBaseRefDefault.mockReset()
  searchBaseRefs.mockReset()
  searchBaseRefDetails.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: {
        getBaseRefDefault,
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
      searchRuntimeRepoBaseRefs('local', 'repo-1', 'x'.repeat(3 * 1024), 20)
    ).resolves.toEqual([])

    expect(searchBaseRefs).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('rejects oversized runtime base-ref detail searches before RPC', async () => {
    await expect(
      searchRuntimeRepoBaseRefDetails(
        'runtime:env-1',
        'repo-1',
        'secret-token-value'.repeat(256),
        20
      )
    ).resolves.toEqual([])

    expect(searchBaseRefDetails).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('forwards the selected SSH host to base-ref IPC', async () => {
    getBaseRefDefault.mockResolvedValue({ defaultBaseRef: 'origin/main', remoteCount: 1 })
    searchBaseRefs.mockResolvedValue(['origin/main'])

    await getRuntimeRepoBaseRefDefault('ssh:server', 'same-repo')
    await searchRuntimeRepoBaseRefs('ssh:server', 'same-repo', 'main', 20)

    expect(getBaseRefDefault).toHaveBeenCalledWith({
      repoId: 'same-repo',
      hostId: 'ssh:server'
    })
    expect(searchBaseRefs).toHaveBeenCalledWith({
      repoId: 'same-repo',
      query: 'main',
      limit: 20,
      hostId: 'ssh:server'
    })
  })
})
