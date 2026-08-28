import React from 'react'

import { cn } from '@/lib/utils'
import ProjectViewWrapper from '@/components/github-project/ProjectViewWrapper'
import {
  TaskPageSourceToolbar,
  type TaskPageSourceToolbarProps
} from '@/components/task-page/chrome/task-page-source-toolbar'
import {
  TaskPageGithubModeBar,
  type TaskPageGithubModeBarProps
} from '@/components/task-page/chrome/task-page-github-mode-bar'
import {
  TaskPageGithubItemFilters,
  type TaskPageGithubItemFiltersProps
} from '@/components/task-page/chrome/task-page-github-item-filters'
import {
  TaskPageLinearFilters,
  type TaskPageLinearFiltersProps
} from '@/components/task-page/chrome/task-page-linear-filters'
import {
  TaskPageJiraFilters,
  type TaskPageJiraFiltersProps
} from '@/components/task-page/chrome/task-page-jira-filters'
import {
  TaskPageGitlabFilters,
  type TaskPageGitlabFiltersProps
} from '@/components/task-page/chrome/task-page-gitlab-filters'
import {
  GithubDetailHost,
  type GithubDetailHostProps
} from '@/components/task-page/github/github-detail-host'
import {
  GithubWorkItemTable,
  type GithubWorkItemTableProps
} from '@/components/task-page/github/github-work-item-table'
import { GitlabTodosList } from '@/components/task-page/gitlab/gitlab-todos-list'
import {
  GitlabWorkItemList,
  type GitlabWorkItemListProps
} from '@/components/task-page/gitlab/gitlab-work-item-list'
import {
  JiraIssueListHost,
  type JiraIssueListHostProps
} from '@/components/task-page/jira/jira-issue-list-host'
import {
  NewGithubIssueDialog,
  type NewGithubIssueDialogProps
} from '@/components/task-page/dialogs/new-github-issue-dialog'
import {
  NewLinearProjectDialog,
  type NewLinearProjectDialogProps
} from '@/components/task-page/dialogs/new-linear-project-dialog'
import {
  NewLinearIssueDialog,
  type NewLinearIssueDialogProps
} from '@/components/task-page/dialogs/new-linear-issue-dialog'
import {
  NewJiraIssueDialog,
  type NewJiraIssueDialogProps
} from '@/components/task-page/dialogs/new-jira-issue-dialog'
import {
  TaskPageConnectDialogs,
  type TaskPageConnectDialogsProps
} from '@/components/task-page/dialogs/task-page-connect-dialogs'
import {
  LinearViewsHost,
  type LinearViewsHostProps
} from '@/components/task-page/linear/linear-views-host'
import type { GitLabTodo } from '../../../../shared/gitlab-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskProvider } from '../../../../shared/task-providers'

export function TaskPageLayout({
  taskPageListChromeHidden,
  sourceToolbar,
  taskSource,
  githubModeBar,
  githubMode,
  githubItemFilters,
  linearConnected,
  linearFilters,
  jiraConnected,
  jiraFilters,
  gitlabFilters,
  githubDetail,
  repoSelection,
  githubTable,
  gitlabView,
  gitlabTodosLoading,
  gitlabTodos,
  primaryRepo,
  gitlabList,
  jiraList,
  linearViews,
  newGithubIssue,
  newLinearProject,
  newLinearIssue,
  newJiraIssue,
  connectDialogs
}: {
  taskPageListChromeHidden: boolean
  sourceToolbar: TaskPageSourceToolbarProps
  taskSource: TaskProvider
  githubModeBar: TaskPageGithubModeBarProps
  githubMode: 'items' | 'project'
  githubItemFilters: TaskPageGithubItemFiltersProps
  linearConnected: boolean
  linearFilters: TaskPageLinearFiltersProps
  jiraConnected: boolean
  jiraFilters: TaskPageJiraFiltersProps
  gitlabFilters: TaskPageGitlabFiltersProps
  githubDetail: GithubDetailHostProps | null
  repoSelection: ReadonlySet<string>
  githubTable: GithubWorkItemTableProps
  gitlabView: 'issues' | 'mrs' | 'todos'
  gitlabTodosLoading: boolean
  gitlabTodos: GitLabTodo[]
  primaryRepo: Repo | null
  gitlabList: GitlabWorkItemListProps
  jiraList: JiraIssueListHostProps
  linearViews: LinearViewsHostProps
  newGithubIssue: NewGithubIssueDialogProps
  newLinearProject: NewLinearProjectDialogProps
  newLinearIssue: NewLinearIssueDialogProps
  newJiraIssue: NewJiraIssueDialogProps
  connectDialogs: TaskPageConnectDialogsProps
}): React.JSX.Element {
  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Why: pt-1.5 (6px) aligns this 32px icon cluster's center with the sidebar Tasks row, 22px below the titlebar. */}
        <div className="mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col px-5 pt-1.5 pb-4 md:px-8 md:pt-1.5 md:pb-5">
          <div
            className={cn('flex-none flex flex-col gap-2', taskPageListChromeHidden && 'hidden')}
          >
            <section className="flex flex-col gap-2">
              <div className="flex flex-col gap-2">
                <TaskPageSourceToolbar {...sourceToolbar} />
                {taskSource === 'github' ? <TaskPageGithubModeBar {...githubModeBar} /> : null}
                {taskSource === 'github' && githubMode === 'items' ? (
                  <TaskPageGithubItemFilters {...githubItemFilters} />
                ) : taskSource === 'linear' && linearConnected ? (
                  <TaskPageLinearFilters {...linearFilters} />
                ) : taskSource === 'jira' && jiraConnected ? (
                  <TaskPageJiraFilters {...jiraFilters} />
                ) : taskSource === 'gitlab' ? (
                  <TaskPageGitlabFilters {...gitlabFilters} />
                ) : null}
              </div>
            </section>
          </div>
          {taskSource === 'github' && githubDetail ? (
            <GithubDetailHost {...githubDetail} />
          ) : taskSource === 'github' && githubMode === 'project' ? (
            <div className="mt-3 flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
              <ProjectViewWrapper selectedRepoIds={repoSelection} />
            </div>
          ) : taskSource === 'github' ? (
            <GithubWorkItemTable {...githubTable} />
          ) : taskSource === 'gitlab' && gitlabView === 'todos' ? (
            <GitlabTodosList
              gitlabTodosLoading={gitlabTodosLoading}
              gitlabTodos={gitlabTodos}
              primaryRepo={primaryRepo}
            />
          ) : taskSource === 'gitlab' ? (
            <GitlabWorkItemList {...gitlabList} />
          ) : taskSource === 'jira' ? (
            <JiraIssueListHost {...jiraList} />
          ) : taskSource === 'linear' ? (
            <LinearViewsHost {...linearViews} />
          ) : null}
        </div>
      </div>
      <NewGithubIssueDialog {...newGithubIssue} />
      <NewLinearProjectDialog {...newLinearProject} />
      <NewLinearIssueDialog {...newLinearIssue} />
      <NewJiraIssueDialog {...newJiraIssue} />
      <TaskPageConnectDialogs {...connectDialogs} />
    </div>
  )
}
