import type { GitHubIssueOrPRLink } from '../../../shared/github/links'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { lookupGitHubWorkItemByOwnerRepoForSource } from './github-work-item-source-lookup'

export async function lookupCmdJGitHubUrlWorkItem(args: {
  link: GitHubIssueOrPRLink
  repo: Pick<Repo, 'id' | 'path'> | null
  sourceContext: TaskSourceContext | null
}): Promise<GitHubWorkItem | null> {
  if (!args.repo) {
    return null
  }
  try {
    return await lookupGitHubWorkItemByOwnerRepoForSource({
      repoPath: args.repo.path,
      repoId: args.repo.id,
      sourceContext: args.sourceContext,
      owner: args.link.slug.owner,
      repo: args.link.slug.repo,
      ...(args.link.slug.host ? { host: args.link.slug.host } : {}),
      number: args.link.number,
      type: args.link.type
    })
  } catch {
    return null
  }
}
