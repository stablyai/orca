import type { TaskPageLinearCreationStateModel } from './linear/use-task-page-linear-creation-state'
import { useMemo } from 'react'
import type { GitHubTaskKind } from '../../../../shared/work-items/task-github-search'
import { buildGitHubRepoUrl } from '../../../../shared/github/links'
import { getTaskSourceContextSummary } from '../task-source-context-summary'
import { getGitHubProjectSourceSummary } from './task-page-source-context'

type TaskPageSourceDisplayInput = TaskPageLinearCreationStateModel & {
  activeGithubTaskKind: GitHubTaskKind
}

/** The Tasks source claims (summary, repo link) come from the list's resolved sources once mode and kind are known. */
export function useTaskPageSourceDisplay<Model extends TaskPageSourceDisplayInput>(model: Model) {
  const {
    taskSource,
    githubMode,
    sourceOptions,
    selectedRepos,
    perRepoSourceState,
    githubSourceDisplayState,
    taskSourceRepoContexts,
    taskSourceHostAvailability,
    accountBackedTaskSourceHostId,
    accountBackedTaskSourceHostAvailability,
    hostRegistryById,
    hostLabelById,
    selectedLinearWorkspace,
    selectedJiraSite,
    activeGithubTaskKind
  } = model
  // Why strict kind: Issues and PRs resolve independently; the other kind's repo is not this list's source.
  const githubActiveSources = useMemo(
    () =>
      githubSourceDisplayState.map(
        ({ sources }) => (activeGithubTaskKind === 'prs' ? sources?.prs : sources?.issues) ?? null
      ),
    [activeGithubTaskKind, githubSourceDisplayState]
  )
  const linearWorkspaceName =
    selectedLinearWorkspace?.organizationName ?? selectedLinearWorkspace?.id ?? null
  const jiraSiteName = selectedJiraSite?.displayName ?? selectedJiraSite?.siteUrl ?? null
  // Why the catalog dep: it changes with the language, and the summary's own copy is translated too.
  const taskSourceContextSummary = useMemo(() => {
    const providerLabel =
      sourceOptions.find((source) => source.id === taskSource)?.label ?? taskSource
    if (taskSource === 'github' && githubMode === 'project') {
      return getGitHubProjectSourceSummary({
        providerLabel,
        hostId: accountBackedTaskSourceHostId,
        host: hostRegistryById.get(accountBackedTaskSourceHostId),
        hostLabelById
      })
    }
    if (taskSource === 'linear' || taskSource === 'jira') {
      return getTaskSourceContextSummary({
        provider: taskSource,
        providerLabel,
        hostAvailability: accountBackedTaskSourceHostAvailability,
        accountHostId: accountBackedTaskSourceHostId,
        hostLabelById,
        linearWorkspaceName,
        jiraSiteName
      })
    }
    return getTaskSourceContextSummary({
      provider: taskSource,
      providerLabel,
      repoContexts: taskSourceRepoContexts,
      // Why: GitLab resolves no list source here, so it makes no repository claim.
      repoIdentities:
        taskSource === 'github'
          ? githubActiveSources.map((source) =>
              source ? { provider: 'github' as const, ...source } : null
            )
          : taskSourceRepoContexts.map(() => null),
      hostAvailability: taskSourceHostAvailability,
      hostLabelById,
      selectedRepoCount: selectedRepos.length
    })
  }, [
    accountBackedTaskSourceHostAvailability,
    accountBackedTaskSourceHostId,
    githubActiveSources,
    githubMode,
    hostLabelById,
    hostRegistryById,
    jiraSiteName,
    linearWorkspaceName,
    selectedRepos.length,
    sourceOptions,
    taskSource,
    taskSourceHostAvailability,
    taskSourceRepoContexts
  ])
  const selectedGitHubRepoExternalLink = useMemo(() => {
    if (selectedRepos.length !== 1) {
      return null
    }
    const [repo] = selectedRepos
    // Why: Projects keeps its selected-repository shortcut; Issues/PRs open exactly the listed source.
    const projectSources =
      githubMode === 'project'
        ? perRepoSourceState.find((state) => state.repoId === repo.id)?.sources
        : null
    const slug =
      githubMode === 'project'
        ? activeGithubTaskKind === 'issues'
          ? (projectSources?.issues ?? projectSources?.prs)
          : (projectSources?.prs ?? projectSources?.issues)
        : githubActiveSources[0]
    const url = buildGitHubRepoUrl(slug)
    return url && slug ? { url, label: `${slug.owner}/${slug.repo}` } : null
  }, [activeGithubTaskKind, githubActiveSources, githubMode, perRepoSourceState, selectedRepos])
  return Object.assign(model, {
    taskSourceContextSummary,
    selectedGitHubRepoExternalLink
  })
}
