import {
  beginListEntry,
  confirmListOperation,
  deleteConfirmedListSnapshot,
  listInput,
  setPendingTaskPageGitHubOp,
  type ListAddress
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import {
  observeGitHubWorkItem,
  type GitHubTaskObservation,
  captureGitHubTaskObservation
} from './github-task-observation'

import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'

import { vi, type Mock } from 'vitest'

import type { GithubWorkItemApi } from '../../../preload/api/github-work-item-api'
import type { GithubPullRequestApi } from '../../../preload/api/github-pull-request-api'
import type { RepositoryApi } from '../../../preload/api/repository-api'

// @vitest-environment happy-dom
import type { Repo } from '../../../shared/repo-types'

import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'

import type { GitHubProjectTable, GitHubProjectRow } from '../../../shared/github/project-types'

import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'

import { getTaskSourceCacheScope } from '../../../shared/task-source-context'

import { workItemsCacheKey, projectViewCacheKey } from '@/store/github/cache-identity'

import { buildTaskPageGitHubResumeContextKey } from '@/components/task-page/github/task-page-github-resume-cache'

import { buildSelectedReposKey } from '@/components/task-page/task-page-work-item-pagination'

export const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local',
  ghAccount: { host: 'github.com', user: 'alice' }
}
export const source = getTaskPageRepoSourceContext(repo, 'github')!
export const key = workItemsCacheKey(repo.id, 30, '', getTaskSourceCacheScope(source))
export const projectKey = projectViewCacheKey('organization', 'o', 1, 'view')
export const user = (login: string) => ({ login, name: login, avatarUrl: `${login}.png` })
export const seed: GitHubWorkItem = {
  id: 'https://github.com/o/r/issues/5',
  repoId: repo.id,
  repoHostId: 'local',
  type: 'issue',
  number: 5,
  url: 'https://github.com/o/r/issues/5',
  title: 'Opening seed',
  state: 'open',
  labels: [],
  author: null,
  updatedAt: ''
}
export const oldDetails: GitHubWorkItemDetails = {
  item: { ...seed, assignees: [user('alice')] },
  body: 'Old body',
  comments: []
}
export const returned: GitHubWorkItemDetails = {
  item: {
    ...seed,
    id: 'provider-node',
    title: 'Accepted title',
    state: 'open',
    assignees: [user('alice'), user('bob')],
    labels: ['fresh']
  },
  body: 'Accepted body',
  comments: []
}
export const projectRow: GitHubProjectRow = {
  id: 'project-row',
  itemType: 'ISSUE',
  content: {
    title: seed.title,
    body: 'Old body',
    url: seed.url,
    number: 5,
    state: 'OPEN',
    stateReason: null,
    isDraft: null,
    labels: [],
    assignees: [],
    repository: 'o/r',
    parentIssue: null,
    issueType: null
  },
  fieldValuesByFieldId: {},
  updatedAt: 'project-time',
  position: 7
}
export const table: GitHubProjectTable = {
  project: {
    id: 'p',
    owner: 'o',
    ownerType: 'organization',
    number: 1,
    title: 'Project',
    url: 'https://github.com/orgs/o/projects/1'
  },
  selectedView: {
    id: 'view',
    number: 1,
    name: 'Table',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [],
    groupByFields: [],
    sortByFields: []
  },
  rows: [projectRow],
  totalCount: 1,
  parentFieldDropped: false
}
export const request = {
  owner: 'o',
  ownerType: 'organization' as const,
  projectNumber: 1,
  viewId: 'view'
}
export const resume = buildTaskPageGitHubResumeContextKey({
  selectedReposKey: buildSelectedReposKey(
    [repo],
    () => source,
    (row) => captureGitHubTaskObservation(row, source)?.key
  ),
  query: '',
  pageSize: 30
})

export type TaskRefreshCalls = {
  direct: GithubWorkItemApi['workItemDetails']
  update: (
    args: (
      | Parameters<GithubWorkItemApi['updateIssue']>[0]
      | Parameters<GithubPullRequestApi['updatePRState']>[0]
      | Parameters<GithubPullRequestApi['mergePR']>[0]
      | Parameters<GithubWorkItemApi['updateIssueBySlug']>[0]
    ) & { updates?: Parameters<GithubWorkItemApi['updateIssue']>[0]['updates'] }
  ) => Promise<{ ok: boolean; error?: string | { type: string; message: string } }>
  // List/comment gates deliberately hold opaque payloads until the test resolves them.
  list: (
    args: Parameters<GithubWorkItemApi['listWorkItems']>[0] & { repoId: string }
  ) => Promise<unknown>
  issueType: (
    args: Parameters<GithubWorkItemApi['updateIssueTypeBySlug']>[0]
  ) => Promise<{ ok: boolean; error?: { type: string; message: string } }>
  projectRead: GithubWorkItemApi['getProjectViewTable']
  postComment: (args: Parameters<GithubWorkItemApi['addIssueComment']>[0]) => Promise<unknown>
}
export type TaskRefreshApiMocks = { [K in keyof TaskRefreshCalls]: Mock<TaskRefreshCalls[K]> }
export type TaskRefreshApi = {
  gh: {
    viewer: Mock<() => Promise<{ login: string }>>
    workItemDetails: TaskRefreshApiMocks['direct']
    updateIssue: TaskRefreshApiMocks['update']
    updatePRState: TaskRefreshApiMocks['update']
    mergePR: TaskRefreshApiMocks['update']
    updateIssueBySlug: TaskRefreshApiMocks['update']
    addIssueComment: TaskRefreshApiMocks['postComment']
    listWorkItems: TaskRefreshApiMocks['list']
    countWorkItems: Mock<
      (args: Parameters<GithubWorkItemApi['countWorkItems']>[0]) => Promise<number>
    >
    getProjectViewTable: TaskRefreshApiMocks['projectRead']
    updateIssueTypeBySlug: TaskRefreshApiMocks['issueType']
  }
  repos: {
    update: Mock<(args: Parameters<RepositoryApi['update']>[0]) => Promise<void>>
  }
  shell: { openUrl: Mock<(url: string) => void> }
  ui: { writeClipboardText: Mock<(text: string) => Promise<void>> }
}

export function createTaskRefreshApi({
  direct,
  update,
  list,
  issueType,
  projectRead,
  postComment
}: TaskRefreshApiMocks): TaskRefreshApi {
  return {
    gh: {
      viewer: vi.fn<() => Promise<{ login: string }>>().mockResolvedValue({ login: 'alice' }),
      workItemDetails: direct,
      updateIssue: update,
      updatePRState: update,
      mergePR: update,
      updateIssueBySlug: update,
      addIssueComment: postComment,
      listWorkItems: list,
      countWorkItems: vi
        .fn<(args: Parameters<GithubWorkItemApi['countWorkItems']>[0]) => Promise<number>>()
        .mockResolvedValue(0),
      getProjectViewTable: projectRead,
      updateIssueTypeBySlug: issueType
    },
    repos: {
      update: vi
        .fn<(args: Parameters<RepositoryApi['update']>[0]) => Promise<void>>()
        .mockResolvedValue(undefined)
    },
    shell: { openUrl: vi.fn<(url: string) => void>() },
    ui: {
      writeClipboardText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    }
  }
}
export function confirmListForTest(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: 'assignees' | 'reviewRequests',
  users: GitHubAssignableUser[],
  observation?: GitHubTaskObservation
) {
  const address: ListAddress = {
    sourceScope,
    repoId,
    itemId,
    family,
    observation,
    itemType: 'issue'
  }
  deleteConfirmedListSnapshot(sourceScope, repoId, itemId, family, observation)
  const input = listInput(
    observeGitHubWorkItem({ ...seed, repoId, [family]: users }, observation, true),
    family,
    observation
  )
  beginListEntry(address, input)
  const key = { ...address, opKey: 'fixture-list' }
  setPendingTaskPageGitHubOp({
    key,
    generation: 1,
    previous: {},
    next: {},
    listOp: { family, kind: 'add', logins: users.map((user) => user.login.toLowerCase()), users },
    startedAt: 0,
    skipMeQualifiers: false
  })
  confirmListOperation(key, 1, input)
}
