import type React from 'react'
import type { parseGitHubIssueOrPRLink } from '@/lib/github-links'
import {
  lookupGitHubWorkItemByOwnerRepoForSource,
  lookupGitHubWorkItemForSource
} from '@/lib/github-work-item-source-lookup'
import { lookupSmartGitHubSubmitItem } from '@/lib/smart-github-submit'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import {
  buildTaskSourceContextFromRepo,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type {
  CrossRepoPrompt,
  RepoBackedSearchTarget,
  RepoOption
} from './smart-workspace-name-field-model'
import { findMatchingRepoForSlug, getRepoSlugCached, sameSlug } from './smart-workspace-repo-slug'

type DirectLink = NonNullable<ReturnType<typeof parseGitHubIssueOrPRLink>>

export async function resolveSmartWorkspaceGithubDirectLink({
  directLink,
  crossRepoSwitchTarget,
  repoBackedSearchTargets,
  selectedRepo,
  githubSourceContext,
  repos,
  repoSlugCache,
  handledCrossRepoUrlRef,
  query
}: {
  directLink: DirectLink
  crossRepoSwitchTarget: 'project' | 'task-source'
  repoBackedSearchTargets: readonly RepoBackedSearchTarget[]
  selectedRepo: RepoOption | null
  githubSourceContext: TaskSourceContext | null
  repos: readonly RepoOption[]
  repoSlugCache: Map<string, DirectLink['slug']>
  handledCrossRepoUrlRef: React.RefObject<string | null>
  query: string
}): Promise<{ items: GitHubWorkItem[]; prompt: CrossRepoPrompt | null }> {
  if (crossRepoSwitchTarget === 'task-source') {
    const matchingTarget = await findMatchingRepoForSlug(
      repoBackedSearchTargets.map((target) => ({
        repo: target.repo,
        sourceContext: target.githubSourceContext
      })),
      directLink.slug,
      repoSlugCache
    )
    if (!matchingTarget) {
      return { items: [], prompt: null }
    }
    const item = await lookupGitHubWorkItemByOwnerRepoForSource({
      repoPath: matchingTarget.repo.path,
      repoId: matchingTarget.repo.id,
      sourceContext: matchingTarget.sourceContext,
      owner: directLink.slug.owner,
      repo: directLink.slug.repo,
      ...(directLink.slug.host ? { host: directLink.slug.host } : {}),
      number: directLink.number,
      type: directLink.type
    })
    // Why: transient GHES slug failures must remain retryable.
    handledCrossRepoUrlRef.current = query
    return {
      items: item ? [{ ...item, repoId: matchingTarget.repo.id } as GitHubWorkItem] : [],
      prompt: null
    }
  }
  if (!selectedRepo?.path) {
    return { items: [], prompt: null }
  }
  const selectedSlug = await getRepoSlugCached(selectedRepo, githubSourceContext, repoSlugCache)
  if (!selectedSlug || sameSlug(selectedSlug, directLink.slug)) {
    handledCrossRepoUrlRef.current = query
    const item = await lookupSmartGitHubSubmitItem({
      repoPath: selectedRepo.path,
      repoId: selectedRepo.id,
      sourceContext: githubSourceContext,
      intent: {
        kind: 'link',
        owner: directLink.slug.owner,
        repo: directLink.slug.repo,
        ...(directLink.slug.host ? { host: directLink.slug.host } : {}),
        number: directLink.number,
        type: directLink.type
      },
      workItem: lookupGitHubWorkItemForSource,
      workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
    })
    return { items: item ? [item] : [], prompt: null }
  }
  const matchingTarget = await findMatchingRepoForSlug(
    repos.map((repo) => ({
      repo,
      sourceContext: buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: repo.id,
        repo
      })
    })),
    directLink.slug,
    repoSlugCache
  )
  return {
    items: [],
    prompt: { link: directLink, matchingRepo: matchingTarget?.repo ?? null }
  }
}
