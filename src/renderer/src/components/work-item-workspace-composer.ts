import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import type { Repo } from '../../../shared/repo-types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import type { AppState } from '@/store/types'
import {
  getGitHubWorkItemWorkspaceSeed,
  getGitLabWorkItemWorkspaceSeed,
  getTaskPageRepoSourceContext
} from './task-page-source-context'

type OpenModal = AppState['openModal']

export function openComposerForGitHubWorkItem(
  repos: readonly Repo[],
  openModal: OpenModal,
  item: GitHubWorkItem
): void {
  const linkedWorkItem: LinkedWorkItemSummary = {
    provider: 'github',
    type: item.type,
    number: item.number,
    title: item.title,
    url: item.url,
    ...(item.repoId ? { repoId: item.repoId } : {})
  }
  openModal('new-workspace-composer', {
    linkedWorkItem,
    initialGitHubWorkItem: item,
    taskSourceContext: getTaskPageRepoSourceContext(getWorkItemRepo(repos, item), 'github'),
    prefilledName: getGitHubWorkItemWorkspaceSeed(item),
    initialRepoId: item.repoId,
    enableIssueAutomation: item.type === 'issue',
    telemetrySource: 'sidebar'
  })
}

export function openComposerForGitLabWorkItem(
  repos: readonly Repo[],
  openModal: OpenModal,
  item: GitLabWorkItem
): void {
  const linkedWorkItem: LinkedWorkItemSummary = {
    provider: 'gitlab',
    type: item.type,
    number: item.number,
    title: item.title,
    url: item.url,
    ...(item.repoId ? { repoId: item.repoId } : {})
  }
  openModal('new-workspace-composer', {
    linkedWorkItem,
    taskSourceContext: getTaskPageRepoSourceContext(
      getWorkItemRepo(repos, item),
      'gitlab',
      item.projectRef
    ),
    prefilledName: getGitLabWorkItemWorkspaceSeed(item),
    initialRepoId: item.repoId,
    telemetrySource: 'sidebar'
  })
}
