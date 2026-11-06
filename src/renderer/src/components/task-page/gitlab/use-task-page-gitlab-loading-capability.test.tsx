// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { GITLAB_MR_INVOLVEMENT_RUNTIME_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { useTaskPageGitLabLoading } from './use-task-page-gitlab-loading'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

const environmentCall = vi.fn()

function statusResponse(supportsFilter: boolean) {
  const response = createCompatibleRuntimeStatusResponse('runtime-1')
  return {
    ...response,
    result: {
      ...response.result,
      capabilities: (response.result.capabilities ?? []).filter(
        (capability) => supportsFilter || capability !== GITLAB_MR_INVOLVEMENT_RUNTIME_CAPABILITY
      )
    }
  }
}

function callsTo(method: string) {
  return environmentCall.mock.calls.filter(([request]) => request.method === method)
}

function renderMineOnServer(repos: Repo[]) {
  const setGitlabLoading = vi.fn()
  const setGitlabError = vi.fn()
  const view = renderHook(
    ({ nonce }) =>
      useTaskPageGitLabLoading({
        selectedRepos: repos,
        selectedReposKey: `server-${repos.length}`,
        primaryRepo: repos[0],
        taskSource: 'gitlab',
        setGitlabItems: vi.fn(),
        setGitlabLoading,
        setGitlabError,
        gitlabRefreshNonce: nonce,
        gitlabView: 'mrs',
        setGitlabTodos: vi.fn(),
        setGitlabTodosLoading: vi.fn(),
        activeGitlabFilter: 'opened',
        gitlabMRInvolvement: 'authored',
        gitlabItems: [],
        gitlabError: null,
        gitlabLoading: false,
        displayedGitLabItems: [],
        gitlabListQueryKey: null,
        setGitlabListQueryKey: vi.fn()
      }),
    { initialProps: { nonce: 0 } }
  )
  const settled = async () => {
    await waitFor(() => expect(setGitlabLoading).toHaveBeenLastCalledWith(false))
    setGitlabLoading.mockClear()
  }
  return { ...view, settled, setGitlabError }
}

function serverRepos(count: number): Repo[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `server-repo-${index}`,
    path: `/srv/app-${index}`,
    displayName: `app-${index}`,
    badgeColor: '',
    addedAt: 1,
    executionHostId: 'runtime:build-box'
  }))
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  environmentCall.mockReset()
  Object.assign(window, { api: { runtimeEnvironments: { call: environmentCall } } })
})

describe('GitLab MR filter capability checks', () => {
  it.each([12, 120])(
    'asks an older server for its status once per refresh across %s projects',
    async (projectCount) => {
      environmentCall.mockImplementation(async (request: { method: string }) =>
        request.method === 'status.get'
          ? statusResponse(false)
          : { id: 'list', ok: true, result: { items: [] } }
      )
      const { rerender, settled, setGitlabError } = renderMineOnServer(serverRepos(projectCount))

      await settled()
      expect(setGitlabError).toHaveBeenLastCalledWith(expect.any(String))
      // The compatibility check and the capability read share one status probe on a cold client.
      expect(callsTo('status.get')).toHaveLength(1)
      expect(callsTo('gitlab.listMRs')).toHaveLength(0)

      rerender({ nonce: 1 })
      await settled()
      expect(callsTo('status.get')).toHaveLength(2)
      expect(callsTo('gitlab.listMRs')).toHaveLength(0)
    }
  )

  it('shows a failed check as a failure and lists on the checked runtime once it recovers', async () => {
    let statusFails = true
    environmentCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        if (statusFails) {
          throw new Error('Connection lost')
        }
        return statusResponse(true)
      }
      return { id: 'list', ok: true, result: { items: [], page: 1, perPage: 50 } }
    })
    const { rerender, settled, setGitlabError } = renderMineOnServer(serverRepos(2))

    await settled()
    expect(setGitlabError).toHaveBeenLastCalledWith(expect.not.stringContaining('newer Orca'))
    expect(callsTo('gitlab.listMRs')).toHaveLength(0)

    statusFails = false
    rerender({ nonce: 1 })
    await settled()
    expect(callsTo('gitlab.listMRs')).toHaveLength(2)
    for (const [request] of callsTo('gitlab.listMRs')) {
      expect(request).toMatchObject({
        params: expect.objectContaining({ involvement: 'authored' }),
        expectedEnvironmentRuntimeId: 'runtime-1'
      })
    }
  })
})
