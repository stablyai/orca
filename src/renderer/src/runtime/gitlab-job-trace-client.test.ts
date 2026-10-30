import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { loadGitLabJobLogDetails } from './gitlab-job-trace-client'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

const jobTrace = vi.fn()

const gitLabCheck: PRCheckDetail = {
  name: 'Component Tests: Purchase API',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  gitlabJobId: 42
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
  jobTrace.mockReset()
  ;(globalThis as { window?: unknown }).window = { api: { gl: { jobTrace } } }
})

describe('loadGitLabJobLogDetails', () => {
  it('does not request a trace for a manual job that cannot have one', async () => {
    const manualCheck: PRCheckDetail = {
      name: 'deploy: production',
      status: 'completed',
      conclusion: 'neutral',
      url: null,
      gitlabJobId: 77
    }

    const details = await loadGitLabJobLogDetails({
      repoPath: '/repo',
      check: manualCheck
    })

    // Why: GitLab 404s on a job with no trace, so skip the round trip entirely.
    expect(jobTrace).not.toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(details?.jobs).toEqual([])
    expect(details?.summary).toBe('No log is available for this GitLab job.')
  })

  it('gives up on a local IPC call that never settles, matching the remote timeout', async () => {
    vi.useFakeTimers()
    try {
      jobTrace.mockReturnValue(new Promise(() => {}))

      const pending = loadGitLabJobLogDetails({
        repoPath: '/repo',
        check: gitLabCheck
      })
      const assertion = expect(pending).rejects.toThrow('Timed out loading the GitLab job log.')
      await vi.advanceTimersByTimeAsync(65_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
