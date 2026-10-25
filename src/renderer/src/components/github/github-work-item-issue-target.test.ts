import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runIssueUpdate, runWorkItemBodyUpdate } from './github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { runGHEditLabelToggle } from '../github-item-dialog/edit-item-fields/gh-edit-section-mutations'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
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
    vi.stubGlobal('window', {
      api: {
        gh: { updateIssue: vi.fn().mockResolvedValue({ ok: true }), updateIssueBySlug: vi.fn() }
      }
    })
  })

  it('keeps body edits on the registered repo path and passes the opened issue target', async () => {
    await runWorkItemBodyUpdate({
      item,
      repoPath: '/home/fixture/widgets',
      projectOrigin: undefined,
      body: 'Origin edit',
      parsedSlug: ORIGIN
    })

    expect(window.api.gh.updateIssue).toHaveBeenCalledWith({
      repoId: 'repo-1',
      repoPath: '/home/fixture/widgets',
      sourceContext: undefined,
      number: 12,
      updates: { body: 'Origin edit' },
      ownerRepo: ORIGIN
    })
    expect(window.api.gh.updateIssueBySlug).not.toHaveBeenCalled()
  })

  it('saves a Project row body in its upstream repository instead of the fork workspace', async () => {
    vi.mocked(window.api.gh.updateIssueBySlug).mockResolvedValue({ ok: true })

    await runWorkItemBodyUpdate({
      item: { ...item, url: 'https://github.com/upstream-owner/widgets/issues/12' },
      repoPath: '/home/fixture/fork-widgets',
      sourceContext: localSource,
      projectOrigin,
      body: 'Project edit',
      parsedSlug: UPSTREAM
    })

    expect(window.api.gh.updateIssueBySlug).toHaveBeenCalledWith({
      ...UPSTREAM,
      number: 12,
      updates: { body: 'Project edit' }
    })
    expect(window.api.gh.updateIssue).not.toHaveBeenCalled()
  })

  it.each([
    { state: 'closed' as const },
    { addLabels: ['bug'] },
    { addAssignees: ['upstream-assignee'] }
  ])('keeps Project field edits in the row repository: %j', async (updates) => {
    vi.mocked(window.api.gh.updateIssueBySlug).mockResolvedValue({ ok: true })

    await runIssueUpdate({
      repoPath: '/home/fixture/fork-widgets',
      repoId: item.repoId,
      sourceContext: localSource,
      projectOrigin,
      issueRepo: UPSTREAM,
      number: 12,
      updates
    })

    expect(window.api.gh.updateIssueBySlug).toHaveBeenCalledWith({
      ...UPSTREAM,
      number: 12,
      updates
    })
    expect(window.api.gh.updateIssue).not.toHaveBeenCalled()
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

  it.each([
    { localLabels: [], updates: { addLabels: ['bug'] } },
    { localLabels: ['bug'], updates: { removeLabels: ['bug'] } }
  ])(
    'retains the target for both label toggle directions: %j',
    async ({ localLabels, updates }) => {
      let mutation: Promise<unknown> = Promise.resolve()
      runGHEditLabelToggle({
        itemId: item.id,
        itemNumber: item.number,
        itemRepoId: item.repoId,
        repoPath: 'C:\\workspace\\widgets',
        projectOrigin: undefined,
        issueRepo: ORIGIN,
        label: 'bug',
        localLabels,
        run: async (_key, options) => {
          mutation = options.mutate()
          await mutation
        },
        onLabelsChange: vi.fn(),
        patchWorkItem: vi.fn(),
        patchProjectRowIfNeeded: vi.fn(),
        onMutated: vi.fn()
      })
      await mutation

      expect(window.api.gh.updateIssue).toHaveBeenCalledWith(
        expect.objectContaining({ ownerRepo: ORIGIN, updates })
      )
    }
  )
})
