// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { githubUpdateIssue } from './runtime-github-issue-client'
import type { TaskSourceContext } from '../../../shared/task-source-context'

const callRuntimeRpc = vi.fn()
const getActiveRuntimeTarget = vi.fn()
const updateIssueLocal = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  getActiveRuntimeTarget: (...args: unknown[]) => getActiveRuntimeTarget(...args)
}))

beforeEach(() => {
  callRuntimeRpc.mockReset().mockResolvedValue({ ok: true })
  getActiveRuntimeTarget
    .mockReset()
    .mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
  updateIssueLocal.mockReset().mockResolvedValue({ ok: true })
  vi.stubGlobal('window', { api: { gh: { updateIssue: updateIssueLocal } } })
})

describe('runtime GitHub issue client', () => {
  it('routes task-source issue updates to the source repo id on the owning runtime', async () => {
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      repoId: 'source-repo-id'
    }

    await githubUpdateIssue(sourceContext, {
      repoPath: '/local/repo',
      repoId: 'fallback-repo-id',
      issueSourcePreference: 'origin',
      number: 42,
      updates: { state: 'closed' }
    })

    expect(getActiveRuntimeTarget).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: 'env-1' })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.updateIssue',
      {
        repo: 'source-repo-id',
        repoId: 'source-repo-id',
        issueSourcePreference: 'origin',
        number: 42,
        updates: { state: 'closed' }
      },
      { timeoutMs: 30_000 }
    )
    expect(updateIssueLocal).not.toHaveBeenCalled()
  })
})
