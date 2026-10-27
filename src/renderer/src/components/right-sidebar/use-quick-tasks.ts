import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { PER_REPO_FETCH_LIMIT } from '@/lib/new-workspace'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import { useTaskProviderConnections } from '@/components/feature-wall/use-integration-connection-status'
import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'
import {
  GITLAB_TASK_FETCH_CONCURRENCY,
  gitLabTaskRepoSelector
} from '@/components/task-page/gitlab/use-task-page-gitlab-loading'
import { getTaskPresetQuery } from '../../../../shared/task-preset-query'
import { mapSettledWithConcurrency } from '../../../../shared/map-with-concurrency'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getQuickTasksRepoHost, splitQuickTasksReposByHost } from './quick-tasks-repo-hosts'

const QUICK_TASKS_DISPLAY_LIMIT = 50
const GITLAB_LIST_LIMIT = 50

type ProviderList<Item> = {
  enabled: boolean
  /** Kind + repos the items belong to; a refresh keeps them, a switch drops them. */
  listKey: string
  items: readonly Item[]
  loading: boolean
  failed: boolean
}

export type QuickTasks = {
  /** True until provider sign-in checks settle, so the panel can avoid flashing "not connected". */
  checking: boolean
  github: ProviderList<GitHubWorkItem>
  gitlab: ProviderList<GitLabWorkItem>
  jira: ProviderList<JiraIssue>
}

function emptyList<Item>(enabled: boolean): ProviderList<Item> {
  return { enabled, listKey: '', items: [], loading: enabled, failed: false }
}

function startLoading<Item>(previous: ProviderList<Item>, listKey: string): ProviderList<Item> {
  return {
    enabled: true,
    listKey,
    items: previous.listKey === listKey ? previous.items : [],
    loading: true,
    failed: false
  }
}

function reposKeyOf(repos: readonly Repo[]): string {
  return repos.map((repo) => `${repo.id}:${repo.path}`).join('|')
}

/** `reviews` lists GitHub pull requests and GitLab merge requests. */
export type QuickTasksKind = 'issues' | 'reviews'
/** The open-item subset of the Tasks page Jira presets. */
export type QuickTasksJiraPreset = 'assigned' | 'reported' | 'all'

export function useQuickTasks({
  repos,
  githubKind,
  gitlabKind,
  jiraPreset,
  isVisible,
  refreshNonce
}: {
  repos: readonly Repo[]
  githubKind: QuickTasksKind
  gitlabKind: QuickTasksKind
  jiraPreset: QuickTasksJiraPreset
  isVisible: boolean
  refreshNonce: number
}): QuickTasks {
  const connections = useTaskProviderConnections()
  const githubEnabled = connections.github === true
  const gitlabEnabled = connections.gitlab === true
  const jiraEnabled = connections.jira === true
  const checking =
    connections.github === undefined ||
    connections.gitlab === undefined ||
    connections.jira === undefined
  const fetchWorkItemsAcrossRepos = useAppStore((s) => s.fetchWorkItemsAcrossRepos)
  const listJiraIssues = useAppStore((s) => s.listJiraIssues)
  const workItemsInvalidationNonce = useAppStore((s) => s.workItemsInvalidationNonce)
  // Why: a repo whose remote names its forge is never queried on the other one, so it cannot show an empty foreign list.
  const hostRepos = useMemo(() => splitQuickTasksReposByHost(repos), [repos])
  const githubReposKey = reposKeyOf(hostRepos.github)
  const gitlabReposKey = reposKeyOf(hostRepos.gitlab)
  const githubListKey = `${githubKind}|${githubReposKey}`
  const gitlabListKey = `${gitlabKind}|${gitlabReposKey}`
  const jiraListKey = jiraPreset
  const [github, setGithub] = useState<ProviderList<GitHubWorkItem>>(() => emptyList(false))
  const [gitlab, setGitlab] = useState<ProviderList<GitLabWorkItem>>(() => emptyList(false))
  const [jira, setJira] = useState<ProviderList<JiraIssue>>(() => emptyList(false))

  useEffect(() => {
    if (!isVisible) {
      return
    }
    const githubRepos = hostRepos.github
    if (!githubEnabled || githubRepos.length === 0) {
      setGithub(emptyList(false))
      return
    }
    let stale = false
    setGithub((previous) => startLoading(previous, githubListKey))
    // Why: same per-repo limit and preset query as the Tasks page, so both share the SWR cache.
    void fetchWorkItemsAcrossRepos(
      githubRepos.map((repo) => ({
        repoId: repo.id,
        path: repo.path,
        executionHostId: repo.executionHostId,
        sourceContext: getTaskPageRepoSourceContext(repo, 'github')
      })),
      PER_REPO_FETCH_LIMIT,
      QUICK_TASKS_DISPLAY_LIMIT,
      getTaskPresetQuery(githubKind === 'issues' ? 'issues' : 'prs'),
      { force: refreshNonce > 0 }
    )
      .then((result) => {
        if (stale) {
          return
        }
        const failed = result.items.length === 0 && result.failedCount === githubRepos.length
        // Why: when no repo was detected as GitHub, total failure means "not a GitHub project", not an error.
        const hostDetected = githubRepos.some((repo) => getQuickTasksRepoHost(repo) === 'github')
        setGithub({
          enabled: !failed || hostDetected,
          listKey: githubListKey,
          items: result.items,
          loading: false,
          failed
        })
      })
      .catch(() => {
        if (!stale) {
          setGithub({
            enabled: true,
            listKey: githubListKey,
            items: [],
            loading: false,
            failed: true
          })
        }
      })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- githubReposKey covers every repos field read above; keying off the array ref would refetch on every parent render.
  }, [
    fetchWorkItemsAcrossRepos,
    githubEnabled,
    githubKind,
    githubReposKey,
    isVisible,
    refreshNonce,
    workItemsInvalidationNonce
  ])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    const gitlabRepos = hostRepos.gitlab
    if (!gitlabEnabled || gitlabRepos.length === 0) {
      setGitlab(emptyList(false))
      return
    }
    let stale = false
    setGitlab((previous) => startLoading(previous, gitlabListKey))
    void mapSettledWithConcurrency(gitlabRepos, GITLAB_TASK_FETCH_CONCURRENCY, (repo) => {
      const selector = gitLabTaskRepoSelector(repo)
      const api = gitLabApiFor(selector)
      return gitlabKind === 'issues'
        ? api.listIssues({ ...selector, state: 'opened', limit: GITLAB_LIST_LIMIT })
        : api.listMRs({ ...selector, state: 'opened', page: 1, perPage: GITLAB_LIST_LIMIT })
    }).then((results) => {
      if (stale) {
        return
      }
      const items: GitLabWorkItem[] = []
      let failures = 0
      let notFound = 0
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') {
          failures += 1
          return
        }
        const value = result.value
        // Why: not_found means the repo is not a GitLab project (mixed group), not a failure.
        if (value.error?.type === 'not_found') {
          notFound += 1
        } else if (value.error) {
          failures += 1
        }
        const repo = gitlabRepos[index]
        for (const item of value.items ?? []) {
          // Why the host: a twin's two rows share the id, so only the stamp names the row that answered.
          items.push(
            repo ? { ...item, repoId: repo.id, repoHostId: getRepoExecutionHostId(repo) } : item
          )
        }
      })
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      setGitlab({
        // Why: no repo is a GitLab project, so the section would only ever show an empty list.
        enabled: notFound < gitlabRepos.length,
        listKey: gitlabListKey,
        items: items.slice(0, QUICK_TASKS_DISPLAY_LIMIT),
        loading: false,
        failed: items.length === 0 && failures === gitlabRepos.length
      })
    })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- gitlabReposKey covers every repos field read above; keying off the array ref would refetch on every parent render.
  }, [gitlabEnabled, gitlabKind, gitlabReposKey, isVisible, refreshNonce])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    if (!jiraEnabled) {
      setJira(emptyList(false))
      return
    }
    let stale = false
    setJira((previous) => startLoading(previous, jiraListKey))
    // Why: same preset and limit shape as the Tasks page default view, so both share the Jira cache.
    void listJiraIssues(jiraPreset, QUICK_TASKS_DISPLAY_LIMIT, { force: refreshNonce > 0 })
      .then((issues) => {
        if (!stale) {
          setJira({
            enabled: true,
            listKey: jiraListKey,
            items: issues,
            loading: false,
            failed: false
          })
        }
      })
      .catch(() => {
        if (!stale) {
          setJira({ enabled: true, listKey: jiraListKey, items: [], loading: false, failed: true })
        }
      })
    return () => {
      stale = true
    }
  }, [isVisible, jiraEnabled, jiraListKey, jiraPreset, listJiraIssues, refreshNonce])

  return { checking, github, gitlab, jira }
}
