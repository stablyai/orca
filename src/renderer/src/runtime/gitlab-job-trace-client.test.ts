import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { loadGitLabJobLogDetails } from './gitlab-job-trace-client'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc }))

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
  it('returns null for a check that is not a GitLab job, touching no transport', async () => {
    const githubCheck: PRCheckDetail = {
      name: 'verify',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/acme/orca/runs/1',
      checkRunId: 7
    }

    await expect(
      loadGitLabJobLogDetails({ repoPath: '/repo', settings: null, check: githubCheck })
    ).resolves.toBeNull()
    expect(jobTrace).not.toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('asks main for a bounded excerpt over local IPC', async () => {
    jobTrace.mockResolvedValue({ ok: true, trace: 'ERROR: Job failed: exit code 1' })

    const details = await loadGitLabJobLogDetails({
      repoPath: '/repo',
      repoId: 'repo-1',
      settings: { activeRuntimeEnvironmentId: null },
      check: gitLabCheck
    })

    expect(jobTrace).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      jobId: 42,
      projectRef: null,
      logExcerpt: true
    })
    expect(details?.jobs[0]?.logTail).toContain('ERROR: Job failed: exit code 1')
  })

  it('targets the MR project so a fork pipeline trace is not looked up in the wrong project', async () => {
    jobTrace.mockResolvedValue({ ok: true, trace: 'boom' })

    await loadGitLabJobLogDetails({
      repoPath: '/repo',
      repoId: 'repo-1',
      settings: { activeRuntimeEnvironmentId: null },
      check: gitLabCheck,
      projectRef: { host: 'gitlab.example.test', path: 'contributor/orca' }
    })

    expect(jobTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: { host: 'gitlab.example.test', path: 'contributor/orca' }
      })
    )
  })

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
      settings: { activeRuntimeEnvironmentId: null },
      check: manualCheck
    })

    // Why: GitLab 404s on a job with no trace, so skip the round trip entirely.
    expect(jobTrace).not.toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(details?.jobs).toEqual([])
    expect(details?.summary).toBe('No log is available for this GitLab job.')
  })

  // #7732 round 1: a job canceled before it started is `completed`/`cancelled`, so it is
  // fetched; main answers with an empty trace and the row must show that, not an error.
  it('explains an empty trace for a job canceled before it produced output', async () => {
    jobTrace.mockResolvedValue({ ok: true, trace: '' })
    const canceledCheck: PRCheckDetail = {
      name: 'unit',
      status: 'completed',
      conclusion: 'cancelled',
      url: null,
      gitlabJobId: 5
    }

    const details = await loadGitLabJobLogDetails({
      repoPath: '/repo',
      settings: { activeRuntimeEnvironmentId: null },
      check: canceledCheck
    })

    expect(details?.jobs).toEqual([])
    expect(details?.summary).toBe('No log is available for this GitLab job.')
  })

  it('routes to the owning runtime environment and still requests the excerpt', async () => {
    callRuntimeRpc.mockResolvedValue({ ok: true, trace: 'remote failure' })

    await loadGitLabJobLogDetails({
      repoPath: '/repo',
      repoId: 'repo-1',
      settings: { activeRuntimeEnvironmentId: 'env-9' },
      check: gitLabCheck
    })

    expect(jobTrace).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-9' },
      'gitlab.jobTrace',
      // Why: bounding in main keeps the response under the 1 MB transport frame cap.
      { repo: 'repo-1', jobId: 42, projectRef: undefined, logExcerpt: true },
      { timeoutMs: 65_000 }
    )
  })

  it('surfaces the GitLab error verbatim so the panel does not claim "no details"', async () => {
    jobTrace.mockResolvedValue({ ok: false, error: '403 Forbidden' })

    await expect(
      loadGitLabJobLogDetails({
        repoPath: '/repo',
        settings: { activeRuntimeEnvironmentId: null },
        check: gitLabCheck
      })
    ).rejects.toThrow('403 Forbidden')
  })

  it('gives up on a local IPC call that never settles, matching the remote timeout', async () => {
    vi.useFakeTimers()
    try {
      jobTrace.mockReturnValue(new Promise(() => {}))

      const pending = loadGitLabJobLogDetails({
        repoPath: '/repo',
        settings: { activeRuntimeEnvironmentId: null },
        check: gitLabCheck
      })
      const assertion = expect(pending).rejects.toThrow('Timed out loading the GitLab job log.')
      await vi.advanceTimersByTimeAsync(65_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a translated message when GitLab reports a blank error', async () => {
    jobTrace.mockResolvedValue({ ok: false, error: '   ' })

    await expect(
      loadGitLabJobLogDetails({
        repoPath: '/repo',
        settings: { activeRuntimeEnvironmentId: null },
        check: gitLabCheck
      })
    ).rejects.toThrow('Failed to load the GitLab job log.')
  })
})
