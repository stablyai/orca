import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runIssueUpdate, runWorkItemBodyUpdate } from './github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
}))
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
        gh: {
          updateIssue: vi.fn().mockResolvedValue({ ok: true }),
          updateIssueBySlug: vi.fn(),
          updatePullRequestBySlug: vi.fn()
        }
      }
    })
  })

  describe.each(['local', 'runtime:project-source'] as const)('Project source %s', (hostId) => {
    const sourceContext = { ...localSource, hostId }
    it('saves the Project row body through the original exact slug actor', async () => {
      const bodyImageUrls = {
        'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
          'https://private-user-images.githubusercontent.com/1/image.png?jwt=TEST'
      }
      vi.mocked(window.api.gh.updateIssueBySlug).mockResolvedValue({ ok: true, bodyImageUrls })
      vi.mocked(callRuntimeRpc).mockResolvedValue({ ok: true, bodyImageUrls })
      const result = await runWorkItemBodyUpdate({
        item: { ...item, url: 'https://github.com/upstream-owner/widgets/issues/12' },
        repoPath: '/home/fixture/fork-widgets',
        sourceContext,
        projectOrigin,
        body: 'Project edit',
        parsedSlug: UPSTREAM
      })
      expect(result).toEqual({ bodyImageUrls })
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
  it.each([true, false])(
    'forwards local PR body PATCH maps without adding a reread (%s)',
    async (hasMap) => {
      const body =
        '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
      vi.mocked(window.api.gh.updatePullRequestBySlug).mockResolvedValue(
        hasMap
          ? {
              ok: true,
              bodyImageUrls: {
                'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
                  'https://private-user-images.githubusercontent.com/1/image.png?jwt=TEST'
              }
            }
          : { ok: true }
      )
      const result = await runWorkItemBodyUpdate({
        item: { ...item, type: 'pr' },
        repoPath: '/repo',
        sourceContext: localSource,
        projectOrigin: undefined,
        body,
        parsedSlug: ORIGIN
      })
      expect(result).toEqual({
        bodyImageUrls: hasMap
          ? {
              'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
                'https://private-user-images.githubusercontent.com/1/image.png?jwt=TEST'
            }
          : undefined
      })
      expect(window.api.gh.updatePullRequestBySlug).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: {
            body: '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
          }
        })
      )
    }
  )
})
