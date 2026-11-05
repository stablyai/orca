import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runIssueUpdate, runWorkItemBodyUpdate } from './github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { notifyWorkItemDetailsMutation } from './github-work-item-comment-mutations'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn(() => ({ repos: [] })) } }))
vi.mock('@/components/github/github-work-item-comment-mutations', () => ({
  notifyWorkItemDetailsMutation: vi.fn()
}))

const ORIGIN = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
const UPSTREAM = { owner: 'upstream-owner', repo: 'widgets', host: 'github.com' }
const projectOrigin = {
  ...UPSTREAM,
  number: 12,
  type: 'issue' as const,
  projectId: 'project-1',
  projectItemId: 'project-item-12',
  cacheKey: 'project-cache'
}
const localSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'local',
  repoId: 'repo-1'
}
const item: GitHubWorkItem = {
  id: 'issue:12',
  type: 'issue',
  number: 12,
  title: 'Origin issue',
  state: 'open',
  url: 'https://github.com/fork-owner/widgets/issues/12',
  labels: [],
  updatedAt: '',
  author: null,
  repoId: 'repo-1'
}

describe('issue edits retain the displayed repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(callRuntimeRpc).mockResolvedValue({ ok: true })
    vi.stubGlobal('window', {
      api: {
        gh: { updateIssue: vi.fn().mockResolvedValue({ ok: true }), updateIssueBySlug: vi.fn() }
      }
    })
  })

  function expectProjectUpdate(
    sourceContext: TaskSourceContext,
    updates: Parameters<typeof runIssueUpdate>[0]['updates']
  ) {
    const payload = { ...UPSTREAM, number: 12, updates }
    if (sourceContext.hostId === 'local') {
      expect(window.api.gh.updateIssueBySlug).toHaveBeenCalledExactlyOnceWith({
        ...payload,
        wakeWslDistro: true
      })
      expect(callRuntimeRpc).not.toHaveBeenCalled()
    } else {
      expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
        { kind: 'environment', environmentId: 'project-source' },
        'github.project.updateIssueBySlug',
        payload,
        { timeoutMs: 30_000 }
      )
      expect(window.api.gh.updateIssueBySlug).not.toHaveBeenCalled()
    }
    expect(window.api.gh.updateIssue).not.toHaveBeenCalled()
    expect(notifyWorkItemDetailsMutation).toHaveBeenCalledExactlyOnceWith(
      {
        repoPath: '/home/fixture/fork-widgets',
        repoId: item.repoId,
        sourceContext,
        type: 'issue',
        number: 12
      },
      { local: sourceContext.hostId === 'local' }
    )
  }

  describe.each(['local', 'runtime:project-source'] as const)('Project source %s', (hostId) => {
    const sourceContext = { ...localSource, hostId }
    it('saves the Project row body through the original exact slug actor', async () => {
      vi.mocked(window.api.gh.updateIssueBySlug).mockResolvedValue({ ok: true })
      await runWorkItemBodyUpdate({
        item: { ...item, url: 'https://github.com/upstream-owner/widgets/issues/12' },
        repoPath: '/home/fixture/fork-widgets',
        sourceContext,
        projectOrigin,
        body: 'Project edit',
        parsedSlug: UPSTREAM
      })
      expectProjectUpdate(sourceContext, { body: 'Project edit' })
    })
  })

  it.each([
    { state: 'closed' as const },
    { addLabels: ['bug'] },
    { addAssignees: ['fork-assignee'] }
  ])('pins field edits to the opened issue repository: %j', async (updates) => {
    await runIssueUpdate({
      repoPath: 'C:\\workspace\\widgets',
      repoId: 'repo-1',
      projectOrigin: undefined,
      number: 12,
      issueRepo: ORIGIN,
      updates
    })

    expect(window.api.gh.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: 'C:\\workspace\\widgets',
        ownerRepo: ORIGIN,
        updates
      })
    )
    expect(window.api.gh.updateIssueBySlug).not.toHaveBeenCalled()
  })
})
