import { expect, it, vi } from 'vitest'
const { jobTrace } = vi.hoisted(() => ({ jobTrace: vi.fn() }))
vi.mock('./gitlab-owner-api', () => ({
  JOB_TRACE_TIMEOUT_MS: 30000,
  gitLabApiFor: () => ({ jobTrace })
}))
import { loadGitLabJobLogDetails } from './gitlab-job-trace-client'
it('loads the real job log for an optional failure and keeps manual jobs off the trace API', async () => {
  jobTrace.mockResolvedValue({ ok: true, trace: 'Compiler failed: missing module' })
  const check = {
    name: 'test',
    status: 'completed',
    conclusion: 'neutral',
    url: null,
    gitlabJobId: 7,
    gitlabAllowedFailure: true
  } as const
  const details = await loadGitLabJobLogDetails({ repoPath: '/repo', check })
  expect(jobTrace).toHaveBeenCalledWith(expect.objectContaining({ jobId: 7, logExcerpt: true }))
  expect(details?.jobs[0]).toMatchObject({ id: 7, logTail: 'Compiler failed: missing module' })
  await loadGitLabJobLogDetails({
    repoPath: '/repo',
    check: { ...check, gitlabAllowedFailure: undefined }
  })
  expect(jobTrace).toHaveBeenCalledTimes(1)
})
