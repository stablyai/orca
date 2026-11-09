import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import {
  buildCloudEnvironmentAgentPrompt,
  type CloudEnvironmentAgentPromptFailure
} from '../../../shared/cloud-environment-agent-prompt'
import {
  launchSetupAgentWithPrompt,
  pickEnvironmentSetupRepo
} from './environment-setup-agent-launch'

/** `github.com/owner/repo` from a repo's remote identity, lowercased; null for non-GitHub remotes. */
export function githubSlugForRepo(repo: Repo): string | null {
  const key = repo.gitRemoteIdentity?.canonicalKey
    ?.trim()
    .toLowerCase()
    .replace(/\.git$/, '')
  const match = key ? /^github\.com\/([^/]+\/[^/]+)$/.exec(key) : null
  return match ? match[1] : null
}

function slugForUrl(url: string): string | null {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/**
 * The local project the agent should work in: the first environment repo with a matching GitHub
 * remote (the install script runs in the first repo), else the active project.
 */
export function pickCloudEnvironmentAgentRepo(
  repos: readonly Repo[],
  environmentRepoUrls: readonly string[],
  activeRepoId: string | null
): Repo | null {
  const gitRepos = repos.filter((repo) => isGitRepoKind(repo) && !repo.connectionId)
  for (const url of environmentRepoUrls) {
    const slug = slugForUrl(url)
    const match = slug ? gitRepos.find((repo) => githubSlugForRepo(repo) === slug) : undefined
    if (match) {
      return match
    }
  }
  return pickEnvironmentSetupRepo(gitRepos, activeRepoId)
}

export function launchCloudEnvironmentAgent(args: {
  repoId: string
  envId: string
  environmentName: string
  repos: readonly string[]
  envVarNames: readonly string[]
  failure?: CloudEnvironmentAgentPromptFailure
}): Promise<boolean> {
  return launchSetupAgentWithPrompt({
    repoId: args.repoId,
    promptDelivery: 'auto-submit',
    prompt: buildCloudEnvironmentAgentPrompt({
      envId: args.envId,
      environmentName: args.environmentName,
      repos: args.repos,
      envVarNames: args.envVarNames,
      ...(args.failure ? { failure: args.failure } : {})
    })
  })
}
