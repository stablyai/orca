import type { HostedReviewProvider } from '../../../../../../shared/hosted-review'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import {
  branchFromRef,
  normalizeProvider,
  parseRemoteRepo,
  parseUpstream,
  type RemoteRepoRef
} from './remote-repo'

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

// Keep / and : literal in GitHub/Gitea refs; encoding them prevents branch resolution.
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

  // An unresolvable fork upstream would make a base-repo compare link point to a missing branch.
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

  // Without a push target or upstream, no remote branch is known to exist for a working compare link.
  const pushedBranch = input.pushTarget?.branchName?.trim()
  if (!pushedBranch && !upstream) {
    return null
  }

  const provider = normalizeProvider(input.provider) ?? baseRepo.provider ?? headRepo.provider
  // Use the remote branch name; it may differ from the local name.
  const headBranch =
    pushedBranch ||
    (upstream && (!baseRemoteName || upstream.remoteName === baseRemoteName)
      ? upstream.branchName
      : localBranch)

  switch (provider) {
    case null:
      return null
    case 'github':
      return `${baseRepo.webBaseUrl}/compare/${encodeCompareRef(baseBranch)}...${encodeCompareRef(
        githubHeadRef(baseRepo, headRepo, headBranch)
      )}?expand=1`
    case 'gitlab':
      // Open GitLab’s MR form in the source project; the base project cannot resolve a fork’s source branch.
      return appendQuery(`${headRepo.webBaseUrl}/-/merge_requests/new`, {
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
  }
}
