// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import {
  runIssueUpdate,
  runWorkItemBodyUpdate
} from '@/components/github/github-work-item-edit-mutations'
import { GitHubItemDialogIssueBody } from '../open-dialog/github-item-dialog-issue-body'
import type { ConversationTab } from '../discuss-item/conversation-tab'
import { touchWorkItemDetailsCache, workItemDetailsCache } from './work-item-details-cache'

let issueBodyUpdated: ComponentProps<typeof ConversationTab>['onBodyUpdated']
vi.mock('../discuss-item/conversation-tab', () => ({
  ConversationTab: (props: ComponentProps<typeof ConversationTab>) => {
    issueBodyUpdated = props.onBodyUpdated
    return <div>{props.body}</div>
  }
}))
vi.mock('../edit-item-fields/gh-edit-section', () => ({ GHEditSection: () => null }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ repos: [], recordFeatureInteraction: vi.fn() }) }
}))
vi.mock('@/components/github/github-work-item-comment-mutations', () => ({
  notifyWorkItemDetailsMutation: vi.fn()
}))
const NOW = Date.UTC(2026, 9, 31, 12)
const item = (owner: string): GitHubWorkItem => ({
  id: 'issue:93',
  type: 'issue',
  number: 93,
  title: 'Issue',
  state: 'open',
  url: `https://github.com/${owner}/widgets/issues/93`,
  labels: [],
  updatedAt: '',
  author: null,
  repoId: 'clone'
})
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', { api: { gh: { updateIssue: vi.fn(), updateIssueBySlug: vi.fn() } } })
  workItemDetailsCache.clear()
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  workItemDetailsCache.clear()
})

it.each(['repo', 'project'] as const)(
  'installs a saved issue representation through the actual parent cache callback (%s)',
  async (origin) => {
    const opened: GitHubWorkItem = {
      ...item('fork'),
      type: 'issue',
      id: 'issue:93',
      url: 'https://github.com/fork/widgets/issues/93'
    }
    const projectOrigin =
      origin === 'project'
        ? {
            owner: 'fork',
            repo: 'widgets',
            host: 'github.com',
            number: 93,
            type: 'issue' as const,
            projectId: 'p',
            projectItemId: 'row',
            cacheKey: 'p'
          }
        : undefined
    const key = `saved-${origin}`
    const details: GitHubWorkItemDetails = {
      item: opened,
      body: 'old',
      comments: [],
      bodyImageUrls: { 'https://github.com/user-attachments/assets/old': 'old-display' }
    }
    touchWorkItemDetailsCache(key, { details, fetchedAt: NOW })
    await act(async () =>
      root.render(
        <GitHubItemDialogIssueBody
          workItem={opened}
          displayWorkItem={opened}
          repoPath="/clone"
          effectiveRepoId="clone"
          projectOrigin={projectOrigin}
          details={details}
          detailsCacheKey={key}
          loading={false}
          detailsLoaded
          localState="open"
          localLabels={[]}
          onStateChange={() => {}}
          onLabelsChange={() => {}}
          onMutated={() => {}}
          onUse={() => {}}
          onOpenOrUse={() => {}}
          attachedWorkspaceLabel={null}
          onCommentAdded={() => {}}
          canUseDetailsRepoContext
        />
      )
    )
    const savedMap = {
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/new.png?jwt=TEST'
    }
    const update =
      origin === 'repo'
        ? vi.spyOn(window.api.gh, 'updateIssue')
        : vi.spyOn(window.api.gh, 'updateIssueBySlug')
    update.mockResolvedValue({ ok: true, bodyImageUrls: savedMap })
    const save = async (body: string) => {
      const representation = await runWorkItemBodyUpdate({
        item: opened,
        repoPath: '/clone',
        projectOrigin,
        body,
        parsedSlug: { owner: 'fork', repo: 'widgets', host: 'github.com' }
      })
      issueBodyUpdated(body, representation)
    }
    await act(async () =>
      save(
        '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
      )
    )
    expect(workItemDetailsCache.get(key)?.details).toMatchObject({
      body: '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)',
      bodyImageUrls: savedMap
    })
    await runIssueUpdate({
      repoPath: '/clone',
      repoId: 'clone',
      projectOrigin,
      number: 93,
      issueRepo: { owner: 'fork', repo: 'widgets', host: 'github.com' },
      updates: { title: 'metadata' }
    })
    expect(workItemDetailsCache.get(key)?.details?.bodyImageUrls).toEqual(savedMap)
    update.mockResolvedValue({ ok: true })
    await act(async () => save('old-host accepted body'))
    expect(workItemDetailsCache.get(key)?.details?.body).toBe('old-host accepted body')
    expect(workItemDetailsCache.get(key)?.details?.bodyImageUrls).toBeUndefined()
  }
)
