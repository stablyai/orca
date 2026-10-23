import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { PER_REPO_FETCH_LIMIT } from '@/lib/new-workspace'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import { useTaskProviderConnections } from '@/components/feature-wall/use-integration-connection-status'
import { getTaskPageRepoSourceContext } from '@/components/task-page-source-context'
import {
  GITLAB_TASK_FETCH_CONCURRENCY,
  gitLabTaskRepoSelector
} from '@/components/task-page/gitlab/use-task-page-gitlab-loading'
import { getTaskPresetQuery } from '../../../../shared/task-preset-query'
import { mapSettledWithConcurrency } from '../../../../shared/map-with-concurrency'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

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
  /** True until GitHub/GitLab sign-in checks settle, so the panel can avoid flashing "not connected". */
  checking: boolean
  github: ProviderList<GitHubWorkItem>
  gitlab: ProviderList<GitLabWorkItem>
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

/** `reviews` lists GitLab merge requests and GitHub pull requests. */
export type QuickTasksKind = 'issues' | 'reviews'

export function useQuickTasks({
  repos,
  kind,
  isVisible,
  refreshNonce
}: {
  repos: readonly Repo[]
  kind: QuickTasksKind
  isVisible: boolean
  refreshNonce: number
}): QuickTasks {
  const connections = useTaskProviderConnections()
  const githubEnabled = connections.github === true
  const gitlabEnabled = connections.gitlab === true
  const checking = connections.github === undefined || connections.gitlab === undefined
  const fetchWorkItemsAcrossRepos = useAppStore((s) => s.fetchWorkItemsAcrossRepos)
  const workItemsInvalidationNonce = useAppStore((s) => s.workItemsInvalidationNonce)
  const reposKey = useMemo(() => repos.map((repo) => `${repo.id}:${repo.path}`).join('|'), [repos])
  const listKey = `${kind}|${reposKey}`
  const [github, setGithub] = useState<ProviderList<GitHubWorkItem>>(() => emptyList(false))
  const [gitlab, setGitlab] = useState<ProviderList<GitLabWorkItem>>(() => emptyList(false))

  useEffect(() => {
    if (!isVisible) {
      return
    }
    if (!githubEnabled || repos.length === 0) {
      setGithub(emptyList(false))
      return
    }
    let stale = false
    setGithub((previous) => startLoading(previous, listKey))
    // Why: same per-repo limit and preset query as the Tasks page, so both share the SWR cache.
    void fetchWorkItemsAcrossRepos(
      repos.map((repo) => ({
        repoId: repo.id,
        path: repo.path,
        executionHostId: repo.executionHostId,
        sourceContext: getTaskPageRepoSourceContext(repo, 'github')
      })),
      PER_REPO_FETCH_LIMIT,
      QUICK_TASKS_DISPLAY_LIMIT,
      getTaskPresetQuery(kind === 'issues' ? 'issues' : 'prs'),
      { force: refreshNonce > 0 }
    )
      .then((result) => {
        if (!stale) {
          // Why: GitLab-hosted repos in a mixed group fail GitHub lookups; only report total failure.
          const failed = result.items.length === 0 && result.failedCount === repos.length
          setGithub({ enabled: true, listKey, items: result.items, loading: false, failed })
        }
      })
      .catch(() => {
        if (!stale) {
          setGithub({ enabled: true, listKey, items: [], loading: false, failed: true })
        }
      })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reposKey covers every repos field read above; keying off the array ref would refetch on every parent render.
  }, [
    fetchWorkItemsAcrossRepos,
    githubEnabled,
    isVisible,
    kind,
    refreshNonce,
    reposKey,
    workItemsInvalidationNonce
  ])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    if (!gitlabEnabled || repos.length === 0) {
      setGitlab(emptyList(false))
      return
    }
    let stale = false
    setGitlab((previous) => startLoading(previous, listKey))
    void mapSettledWithConcurrency(repos, GITLAB_TASK_FETCH_CONCURRENCY, (repo) => {
      const selector = gitLabTaskRepoSelector(repo)
      const api = gitLabApiFor(selector)
      return kind === 'issues'
        ? api.listIssues({ ...selector, state: 'opened', limit: GITLAB_LIST_LIMIT })
        : api.listMRs({ ...selector, state: 'opened', page: 1, perPage: GITLAB_LIST_LIMIT })
    }).then((results) => {
      if (stale) {
        return
      }
      const items: GitLabWorkItem[] = []
      let failures = 0
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') {
          failures += 1
          return
        }
        const value = result.value
        // Why: not_found means the repo is not a GitLab project (mixed group), not a failure.
        if (value.error && value.error.type !== 'not_found') {
          failures += 1
        }
        const repo = repos[index]
        for (const item of value.items ?? []) {
          // Why the host: a twin's two rows share the id, so only the stamp names the row that answered.
          items.push(
            repo ? { ...item, repoId: repo.id, repoHostId: getRepoExecutionHostId(repo) } : item
          )
        }
      })
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      setGitlab({
        enabled: true,
        listKey,
        items: items.slice(0, QUICK_TASKS_DISPLAY_LIMIT),
        loading: false,
        failed: items.length === 0 && failures === repos.length
      })
    })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reposKey covers every repos field read above; keying off the array ref would refetch on every parent render.
  }, [gitlabEnabled, isVisible, kind, refreshNonce, reposKey])

  return { checking, github, gitlab }
}
