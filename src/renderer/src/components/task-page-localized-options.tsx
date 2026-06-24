import React from 'react'
import { Github, Gitlab, LayoutGrid, List } from 'lucide-react'

import { JiraIcon } from '@/components/icons/JiraIcon'
import { GiteaIcon } from '@/components/icons/GiteaIcon'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { getTaskPresetQuery } from '@/lib/new-workspace'
import type { TaskProvider, TaskViewPresetId } from '../../../shared/types'

export type GitLabTaskFilter = 'opened' | 'merged' | 'closed' | 'all'
export type GitLabIssueFilter = 'opened' | 'assigned-to-me'

export type TaskQueryPreset = {
  id: TaskViewPresetId
  label: string
  query: string
}

export type GitHubTaskKind = 'issues' | 'prs'

export type SourceOption = {
  id: TaskProvider
  label: string
  Icon: (props: { className?: string }) => React.JSX.Element
  disabled?: boolean
}

export type JiraPresetId = 'assigned' | 'reported' | 'all' | 'done'
export type JiraPreset = { id: JiraPresetId; label: string }

export type GitHubModeButton = { id: GitHubTaskKind | 'project'; label: string }

export type LinearViewMode = 'list' | 'board'
export type LinearMode = 'issues' | 'projects' | 'views'
export type LinearGroupBy = 'none' | 'status' | 'assignee' | 'priority' | 'team'
export type LinearOrderBy = 'priority' | 'updated' | 'identifier'
export type LinearDisplayProperty =
  | 'state'
  | 'priority'
  | 'assignee'
  | 'team'
  | 'labels'
  | 'updated'

export function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

export const getGitLabMRFilters = createLocalizedCatalog(
  (): { id: GitLabTaskFilter; label: string }[] => [
    { id: 'opened', label: translate('auto.components.TaskPage.606a85c774', 'Open') },
    { id: 'merged', label: translate('auto.components.TaskPage.37a82eaaf8', 'Merged') },
    { id: 'closed', label: translate('auto.components.TaskPage.d09bf34db7', 'Closed') },
    { id: 'all', label: translate('auto.components.TaskPage.c2268a9982', 'All') }
  ]
)

export const getGitLabIssueFilters = createLocalizedCatalog(
  (): { id: GitLabIssueFilter; label: string }[] => [
    { id: 'opened', label: translate('auto.components.TaskPage.606a85c774', 'Open') },
    {
      id: 'assigned-to-me',
      label: translate('auto.components.TaskPage.94f0339621', 'Assigned to me')
    }
  ]
)

const getIssueTaskQueryPresets = createLocalizedCatalog((): TaskQueryPreset[] => [
  {
    id: 'issues',
    label: translate('auto.components.TaskPage.606a85c774', 'Open'),
    query: getTaskPresetQuery('issues')
  },
  {
    id: 'my-issues',
    label: translate('auto.components.TaskPage.94f0339621', 'Assigned to me'),
    query: getTaskPresetQuery('my-issues')
  }
])

const getPRTaskQueryPresets = createLocalizedCatalog((): TaskQueryPreset[] => [
  {
    id: 'prs',
    label: translate('auto.components.TaskPage.606a85c774', 'Open'),
    query: getTaskPresetQuery('prs')
  },
  {
    id: 'my-prs',
    label: translate('auto.components.TaskPage.7698af5263', 'Mine'),
    query: getTaskPresetQuery('my-prs')
  },
  {
    id: 'review',
    label: translate('auto.components.TaskPage.524f095d55', 'Needs review'),
    query: getTaskPresetQuery('review')
  }
])

export function getGitHubTaskKindPresets(kind: GitHubTaskKind): TaskQueryPreset[] {
  return kind === 'prs' ? getPRTaskQueryPresets() : getIssueTaskQueryPresets()
}

export const getSourceOptions = createLocalizedCatalog((): SourceOption[] => [
  {
    id: 'github',
    label: translate('auto.components.TaskPage.acef77f7ca', 'GitHub'),
    Icon: ({ className }) => <Github className={className} />
  },
  {
    id: 'gitlab',
    label: translate('auto.components.TaskPage.11a828abf8', 'GitLab'),
    Icon: ({ className }) => <Gitlab className={className} />
  },
  {
    id: 'gitea',
    label: translate('auto.components.TaskPage.gitea_src', 'Gitea'),
    Icon: ({ className }) => <GiteaIcon className={className} />
  },
  {
    id: 'linear',
    label: translate('auto.components.TaskPage.8675cd6188', 'Linear'),
    Icon: ({ className }) => <LinearIcon className={className} />
  },
  {
    id: 'jira',
    label: translate('auto.components.TaskPage.9cd11ba218', 'Jira'),
    Icon: ({ className }) => <JiraIcon className={className} />
  }
])

export const getJiraPresets = createLocalizedCatalog((): JiraPreset[] => [
  { id: 'assigned', label: translate('auto.components.TaskPage.1301d376f1', 'Assigned') },
  { id: 'reported', label: translate('auto.components.TaskPage.bd9965df51', 'Reported') },
  { id: 'all', label: translate('auto.components.TaskPage.4b6e40e42c', 'All Open') },
  { id: 'done', label: translate('auto.components.TaskPage.18451e99df', 'Done') }
])

export const getGitHubModeButtons = createLocalizedCatalog((): GitHubModeButton[] => [
  { id: 'issues', label: translate('auto.components.TaskPage.dfc0c79bd8', 'Issues') },
  { id: 'prs', label: translate('auto.components.TaskPage.137e2a8a01', 'PRs') },
  { id: 'project', label: translate('auto.components.TaskPage.727069bee5', 'Projects') }
])

export const getLinearModeOptions = createLocalizedCatalog(
  (): { id: LinearMode; label: string }[] => [
    { id: 'issues', label: translate('auto.components.TaskPage.dfc0c79bd8', 'Issues') },
    { id: 'projects', label: translate('auto.components.TaskPage.727069bee5', 'Projects') },
    { id: 'views', label: translate('auto.components.TaskPage.e78ec261ed', 'Views') }
  ]
)

export const getLinearViewOptions = createLocalizedCatalog(
  (): {
    id: LinearViewMode
    label: string
    Icon: typeof List
  }[] => [
    { id: 'list', label: translate('auto.components.TaskPage.a6f7e93d7f', 'List'), Icon: List },
    {
      id: 'board',
      label: translate('auto.components.TaskPage.d747aed72f', 'Board'),
      Icon: LayoutGrid
    }
  ]
)

export const getLinearGroupOptions = createLocalizedCatalog(
  (): { id: LinearGroupBy; label: string }[] => [
    { id: 'none', label: translate('auto.components.TaskPage.50387522d7', 'No grouping') },
    { id: 'status', label: translate('auto.components.TaskPage.154b0fa623', 'Status') },
    { id: 'assignee', label: translate('auto.components.TaskPage.d2a876ca53', 'Assignee') },
    { id: 'priority', label: translate('auto.components.TaskPage.c8d5bec5f7', 'Priority') },
    { id: 'team', label: translate('auto.components.TaskPage.a98cbe7664', 'Team') }
  ]
)

export const getLinearOrderOptions = createLocalizedCatalog(
  (): { id: LinearOrderBy; label: string }[] => [
    { id: 'priority', label: translate('auto.components.TaskPage.c8d5bec5f7', 'Priority') },
    { id: 'updated', label: translate('auto.components.TaskPage.f362667d55', 'Updated') },
    { id: 'identifier', label: translate('auto.components.TaskPage.d8a517ad89', 'Identifier') }
  ]
)

export const getLinearDisplayProperties = createLocalizedCatalog(
  (): { id: LinearDisplayProperty; label: string }[] => [
    { id: 'state', label: translate('auto.components.TaskPage.154b0fa623', 'Status') },
    { id: 'priority', label: translate('auto.components.TaskPage.c8d5bec5f7', 'Priority') },
    { id: 'assignee', label: translate('auto.components.TaskPage.d2a876ca53', 'Assignee') },
    { id: 'team', label: translate('auto.components.TaskPage.a98cbe7664', 'Team') },
    { id: 'labels', label: translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels') },
    { id: 'updated', label: translate('auto.components.TaskPage.f362667d55', 'Updated') }
  ]
)

export const getLinearPriorityLabels = createLocalizedCatalog(
  (): Record<number, string> => ({
    0: translate('auto.components.TaskPage.713179dfdc', 'No priority'),
    1: translate('auto.components.TaskPage.f373ab1a4f', 'Urgent'),
    2: translate('auto.components.TaskPage.345b169f1f', 'High'),
    3: translate('auto.components.TaskPage.7fd59c18d8', 'Medium'),
    4: translate('auto.components.TaskPage.69591944e7', 'Low')
  })
)

export function getLinearPriorityLabel(priority: number): string {
  return getLinearPriorityLabels()[priority] ?? `P${priority}`
}
