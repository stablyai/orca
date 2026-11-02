import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { loadGiteaJobLogDetails } from './gitea-job-trace-client'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

const jobTrace = vi.fn()

const giteaCheck: PRCheckDetail = {
  name: 'CI: build',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  giteaJobId: 42
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
  jobTrace.mockReset()
  ;(globalThis as { window?: unknown }).window = { api: { gitea: { jobTrace } } }
})

describe('loadGiteaJobLogDetails', () => {
  it('lets other providers handle a check without a Gitea job id', async () => {
    await expect(
      loadGiteaJobLogDetails({ repoPath: '/repo', check: { ...giteaCheck, giteaJobId: undefined } })
    ).resolves.toBeNull()
    expect(jobTrace).not.toHaveBeenCalled()
  })

  it('does not request a trace for a job that never ran', async () => {
    const details = await loadGiteaJobLogDetails({
      repoPath: '/repo',
      check: { ...giteaCheck, status: 'queued', conclusion: 'pending' }
    })
    expect(jobTrace).not.toHaveBeenCalled()
    expect(details?.jobs).toEqual([])
    expect(details?.summary).toBe('No log is available for this Gitea job.')
  })

  it('adapts the trace into one job log tail', async () => {
    jobTrace.mockResolvedValue({ ok: true, trace: 'step 1\nboom' })
    const details = await loadGiteaJobLogDetails({
      repoPath: '/repo',
      repoId: 'r',
      check: giteaCheck
    })
    expect(jobTrace).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'r',
      jobId: 42,
      projectRef: null,
      logExcerpt: true
    })
    expect(details?.jobs).toHaveLength(1)
    expect(details?.jobs[0]).toMatchObject({ id: 42, name: 'CI: build' })
    expect(details?.jobs[0].logTail).toContain('boom')
  })

  it('throws the host error so the caller can show it', async () => {
    jobTrace.mockResolvedValue({ ok: false, error: 'job log expired' })
    await expect(loadGiteaJobLogDetails({ repoPath: '/repo', check: giteaCheck })).rejects.toThrow(
      'job log expired'
    )
  })

  it('gives up on a local IPC call that never settles', async () => {
    vi.useFakeTimers()
    try {
      jobTrace.mockReturnValue(new Promise(() => {}))
      const pending = loadGiteaJobLogDetails({ repoPath: '/repo', check: giteaCheck })
      const assertion = expect(pending).rejects.toThrow('Timed out loading the Gitea job log.')
      await vi.advanceTimersByTimeAsync(65_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
