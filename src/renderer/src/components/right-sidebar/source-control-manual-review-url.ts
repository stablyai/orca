import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import type { GitPushTarget } from '../../../../shared/types'
import {
  branchFromRef,
  normalizeProvider,
  parseRemoteRepo,
  parseUpstream,
  type RemoteRepoRef
} from './source-control-remote-repo'

type ManualReviewUrlInput = {
  baseRef: string | null | undefined
  branchName: string | null | undefined
  repoRemoteName?: string | null
  repoRemoteUrl?: string | null
  provider?: HostedReviewProvider | null
  pushTarget?: GitPushTarget | null
  /** Tracking upstream in `<remote>/<branch>` form (git `branch.upstream`). */
  upstreamName?: string | null
}

export type SourceControlManualReviewContext = ManualReviewUrlInput & {
  hostedReviewProvider?: HostedReviewProvider | null
  hostedReviewCreationProvider?: HostedReviewProvider | null
  linkedGitHubPR?: number | null
  fallbackGitHubPRNumber?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}

export function resolveSourceControlManualReviewProvider(input: {
  hostedReviewProvider?: HostedReviewProvider | null
  hostedReviewCreationProvider?: HostedReviewProvider | null
  linkedGitHubPR?: number | null
  fallbackGitHubPRNumber?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}): HostedReviewProvider | null {
  return (
    input.hostedReviewProvider ??
    input.hostedReviewCreationProvider ??
    (input.linkedGitLabMR != null
      ? 'gitlab'
      : input.linkedBitbucketPR != null
        ? 'bitbucket'
        : input.linkedAzureDevOpsPR != null
          ? 'azure-devops'
          : input.linkedGiteaPR != null
            ? 'gitea'
            : input.linkedGitHubPR != null || input.fallbackGitHubPRNumber != null
              ? 'github'
              : null)
  )
}

export function buildSourceControlManualReviewUrlFromContext(
  input: SourceControlManualReviewContext
): string | null {
  const {
    hostedReviewProvider,
    hostedReviewCreationProvider,
    linkedGitHubPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    ...urlInput
  } = input
  return buildSourceControlManualReviewUrl({
    ...urlInput,
    provider: resolveSourceControlManualReviewProvider({
      hostedReviewProvider,
      hostedReviewCreationProvider,
      linkedGitHubPR,
      fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR
    })
  })
}

function githubHeadRef(base: RemoteRepoRef, head: RemoteRepoRef, branch: string): string {
  if (base.path.toLowerCase() === head.path.toLowerCase()) {
    return branch
  }
  const owner = head.path.split('/')[0]
  return owner ? `${owner}:${branch}` : branch
}

function appendQuery(url: string, values: Record<string, string>): string {
  const search = new URLSearchParams(values)
  return `${url}?${search.toString()}`
}

// GitHub/Gitea compare refs keep '/' (slashed branch names like feature/foo) and
// ':' (the owner:branch fork qualifier) literal; percent-encoding those separators
// makes GitHub fail to resolve the branch. Only the segments between them are encoded.
function encodeCompareRef(ref: string): string {
  return ref
    .split(':')
    .map((segment) => segment.split('/').map(encodeURIComponent).join('/'))
    .join(':')
}

export function buildSourceControlManualReviewUrl(input: ManualReviewUrlInput): string | null {
  const baseBranch = branchFromRef(input.baseRef, input.repoRemoteName)
  const localBranch = input.branchName?.trim()
  if (!baseBranch || !localBranch || localBranch === 'HEAD') {
    return null
  }

  const baseRemoteUrl = input.repoRemoteUrl?.trim() || input.pushTarget?.remoteUrl?.trim()
  const headRemoteUrl = input.pushTarget?.remoteUrl?.trim() || baseRemoteUrl
  if (!baseRemoteUrl || !headRemoteUrl) {
    return null
  }

  // Why: the tracking upstream is the source of truth for where the branch
  // actually lives on the remote. When it tracks a remote we can't resolve to a
  // URL (a fork tracked via plain git, so pushTarget is empty), a base-repo
  // compare link would 404 — suppress instead of pointing at a missing branch.
  const upstream = parseUpstream(input.upstreamName)
  const baseRemoteName = input.repoRemoteName?.trim() || null
  const hasResolvableForkUrl = Boolean(input.pushTarget?.remoteUrl?.trim())
  if (
    upstream &&
    baseRemoteName &&
    upstream.remoteName !== baseRemoteName &&
    !hasResolvableForkUrl
  ) {
    return null
  }

  const baseRepo = parseRemoteRepo(baseRemoteUrl, input.provider)
  const headRepo = parseRemoteRepo(headRemoteUrl, input.provider)
  if (!baseRepo || !headRepo) {
    return null
  }

  // Why: without a pushTarget or tracking upstream there's no evidence the branch
  // exists on any remote, so a compare/PR-create link would land on GitHub's
  // "There isn't anything to compare" page. No link beats a broken one.
  const pushedBranch = input.pushTarget?.branchName?.trim()
  if (!pushedBranch && !upstream) {
    return null
  }

  const provider = normalizeProvider(input.provider) ?? baseRepo.provider ?? headRepo.provider
  // Prefer the pushed branch name (pushTarget, else the tracking upstream on the
  // base remote) so the link matches what exists remotely, not the local name.
  const headBranch =
    pushedBranch ||
    (upstream && (!baseRemoteName || upstream.remoteName === baseRemoteName)
      ? upstream.branchName
      : localBranch)

  switch (provider) {
    case 'github':
      return `${baseRepo.webBaseUrl}/compare/${encodeCompareRef(baseBranch)}...${encodeCompareRef(
        githubHeadRef(baseRepo, headRepo, headBranch)
      )}?expand=1`
    case 'gitlab':
      return appendQuery(`${baseRepo.webBaseUrl}/-/merge_requests/new`, {
        'merge_request[source_branch]': headBranch,
        'merge_request[target_branch]': baseBranch
      })
    case 'bitbucket':
      return appendQuery(`${baseRepo.webBaseUrl}/pull-requests/new`, {
        source: headBranch,
        dest: baseBranch
      })
    case 'azure-devops':
      return appendQuery(`${baseRepo.webBaseUrl}/pullrequestcreate`, {
        sourceRef: `refs/heads/${headBranch}`,
        targetRef: `refs/heads/${baseBranch}`
      })
    case 'gitea':
      return `${baseRepo.webBaseUrl}/compare/${encodeCompareRef(baseBranch)}...${encodeCompareRef(headBranch)}`
    default:
      return null
  }
}
