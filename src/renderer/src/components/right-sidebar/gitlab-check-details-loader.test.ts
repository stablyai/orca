import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { loadGitLabCheckRunDetails } from './gitlab-check-details-loader'
import type { PRCheckDetail } from '../../../../shared/types'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
  }
})

const jobTrace = vi.fn()

const CHECK: PRCheckDetail = {
  name: 'test: unit',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://gitlab.com/acme/orca/-/jobs/1',
  gitlabJobId: 1
}

describe('loadGitLabCheckRunDetails', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset()
    jobTrace.mockReset()
    vi.stubGlobal('window', { api: { gl: { jobTrace } } })
  })

  afterEach(() => {
    // Why: restore the real `window` so sibling suites relying on jsdom's
    // localStorage/DOM aren't broken by this stub leaking across files.
    vi.unstubAllGlobals()
  })

  it('returns null for a non-GitLab check without hitting any transport', async () => {
    const { gitlabJobId: _omit, ...githubCheck } = CHECK

    await expect(
      loadGitLabCheckRunDetails({
        repoPath: '/workspace/app',
        repoId: 'repo-1',
        settings: { activeRuntimeEnvironmentId: null },
        check: githubCheck
      })
    ).resolves.toBeNull()
    expect(jobTrace).not.toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('fetches the trace over the local IPC bridge and adapts it', async () => {
    jobTrace.mockResolvedValue({ ok: true, trace: 'boom' })

    const details = await loadGitLabCheckRunDetails({
      repoPath: '/workspace/app',
      repoId: 'repo-1',
      settings: { activeRuntimeEnvironmentId: null },
      check: CHECK
    })

    expect(jobTrace).toHaveBeenCalledWith({
      repoPath: '/workspace/app',
      repoId: 'repo-1',
      jobId: 1
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(details?.jobs[0]).toMatchObject({ id: 1, logTail: 'boom' })
  })

  it('routes through runtime RPC when a runtime environment is active (SSH/remote)', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({ ok: true, trace: 'remote log' })

    const details = await loadGitLabCheckRunDetails({
      repoPath: '/workspace/app',
      repoId: 'repo-1',
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      check: CHECK
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitlab.jobTrace',
      { repo: 'repo-1', jobId: 1 },
      { timeoutMs: 30_000 }
    )
    expect(jobTrace).not.toHaveBeenCalled()
    expect(details?.jobs[0]?.logTail).toBe('remote log')
  })

  it('throws the GitLab error verbatim when the trace fetch fails', async () => {
    jobTrace.mockResolvedValue({ ok: false, error: 'job log expired' })

    await expect(
      loadGitLabCheckRunDetails({
        repoPath: '/workspace/app',
        repoId: 'repo-1',
        settings: { activeRuntimeEnvironmentId: null },
        check: CHECK
      })
    ).rejects.toThrow('job log expired')
  })
})
