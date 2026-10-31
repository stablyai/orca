import { translate } from '@/i18n/i18n'
import {
  foldComparableGitHubHost,
  foldComparableGitLabHost
} from '../../../shared/git-remote-host-alias'
import {
  matchGitRemoteKeyParts,
  normalizeGitRemoteUrl,
  splitGitRemoteKey,
  type GitRemoteKeyParts
} from '../../../shared/git-remote-identity'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import { pickBestProjectMatch, type ProjectSourceMatcher } from './project-source-match'

// Why both folds: each maps only its own forge's alias hosts, so together they suit any host.
function foldForgeHost(host: string): string {
  return foldComparableGitLabHost(foldComparableGitHubHost(host))
}

function repoName(parts: GitRemoteKeyParts): string {
  return parts.tail.slice(parts.tail.lastIndexOf('/') + 1)
}

/** True when the project is a fork of the target, or the target is likely the project's own fork. */
function isForkRelative(repo: Repo, own: GitRemoteKeyParts | null, target: GitRemoteKeyParts) {
  const parent = repo.upstream
  // Why: older persisted parents have no host; like repoUpstreamIdentityKey, use the clone's own
  // host so an Enterprise parent never collapses into github.com, and refuse when it is unknown.
  const parentHost = parent?.host?.trim().toLowerCase() || own?.host
  if (parent?.owner && parent.repo && parentHost) {
    const parentParts = {
      host: foldForgeHost(parentHost.replace(/:\d+$/, '')),
      tail: `${parent.owner}/${parent.repo.replace(/\.git$/i, '')}`.toLowerCase()
    }
    if (matchGitRemoteKeyParts(parentParts, target) === true) {
      return true
    }
  }
  // Why: the stored identity prefers an `upstream` remote, which hides the clone's own (fork)
  // remote; forks keep the repo name, so the same host and name is the evidence left.
  return (
    repo.gitRemoteIdentity?.remoteName === 'upstream' &&
    own !== null &&
    own.host === target.host &&
    repoName(own) === repoName(target)
  )
}

/**
 * Git projects whose remote is the hint's `projectSource` (any forge). Weaker matches rank below
 * an exact remote: the same path behind an unexpanded SSH host alias, then a fork of or for it.
 */
export const findGitProjectForSource: ProjectSourceMatcher = (repos, hint, activeRepoId) => {
  const remote = hint.projectSource ? normalizeGitRemoteUrl(hint.projectSource) : null
  const target = splitGitRemoteKey(remote, foldForgeHost)
  if (!remote || !target) {
    return null
  }
  const scored = repos.filter(isGitRepoKind).map((repo) => {
    const own = splitGitRemoteKey(repo.gitRemoteIdentity?.canonicalKey, foldForgeHost)
    const verdict = own ? matchGitRemoteKeyParts(own, target) : false
    const score =
      verdict === true ? 3 : verdict === 'unknown' ? 2 : isForkRelative(repo, own, target) ? 1 : 0
    return { repo, score }
  })
  const repoId = pickBestProjectMatch(scored, activeRepoId)
  return repoId
    ? { repoId }
    : {
        missing: translate(
          'auto.lib.gitRemoteProjectMatch.noProject',
          'No Git project in Orca has the remote {{remote}}. Add a clone of it as a project, then start again.',
          { remote }
        )
      }
}
