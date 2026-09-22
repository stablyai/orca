import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { findRepoForHost, getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { resolveProvisionalHostedReviewProvider } from '@/components/right-sidebar/source-control/review/primary-create-pr-intent-action'
import { parseRemoteRepo } from '@/components/right-sidebar/source-control/review/remote-repo'
import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import type { Worktree } from '../../../../shared/worktree/types'
import { getLinkedReviewNumber } from './worktree-card-pr-display'
import type { WorktreeReviewProvider } from './worktree-meta-updates'

// Why: the same trick as use-hosted-review-provider-hint — remember the last
// CONCRETE answer so a reopened dialog never flashes a default while main
// re-reads the remote. Keyed by repo *and execution host*: the same repo id
// exists once per host, and those hosts can have different remotes.
const detectedProviderByRepoHost = new Map<string, WorktreeReviewProvider>()

/** Exported for test: the memo is module-scoped so it survives a remount. */
export function resetDetectedReviewProvidersForTest(): void {
  detectedProviderByRepoHost.clear()
}

/** Which review provider the meta dialog should edit, and the persisted number
 *  in that provider's slot. `provider` is null only while async detection is in
 *  flight — render an inert field for null, never a GitHub one. */
export function useWorktreeReviewProvider(args: {
  isOpen: boolean
  isFolderWorkspace: boolean
  /** The Checks panel names the provider of a review it has already fetched. */
  modalReviewProvider: unknown
  /** The host the opening row belongs to. The same repo id exists once per host. */
  executionHostId: string | undefined
  worktree: Worktree | undefined
}): {
  provider: WorktreeReviewProvider | null
  isResolving: boolean
  /** The save-time baseline: the number actually stored for `provider`, or ''. */
  persistedReview: string
} {
  const { isOpen, isFolderWorkspace, modalReviewProvider, executionHostId, worktree } = args
  const getEligibility = useAppStore((s) => s.getHostedReviewCreationEligibility)
  const settings = useAppStore((s) => s.settings)
  const repos = useAppStore((s) => s.repos)
  const repo = useMemo(
    () =>
      worktree
        ? findRepoForHost(repos, worktree.repoId, { hostId: executionHostId, settings })
        : null,
    [repos, worktree, executionHostId, settings]
  )
  const repoHostKey = repo ? getRepoHostIdentity(repo) : null
  const branch = worktree?.branch.replace(/^refs\/heads\//, '') ?? ''

  // Why: the card's own fetched review is the highest-precedence source and it is
  // already in the store, keyed the same way the card keys it. Reading it here is
  // what stops the eligibility call firing for a workspace whose MR is on screen.
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const hostedReview = useAppStore((s) =>
    hostedReviewCacheKey ? (s.hostedReviewCache[hostedReviewCacheKey]?.data ?? null) : null
  )

  const [detected, setDetected] = useState<WorktreeReviewProvider | null>(null)

  const links = useMemo(
    () => ({
      linkedPR: worktree?.linkedPR ?? null,
      linkedGitLabMR: worktree?.linkedGitLabMR ?? null,
      linkedBitbucketPR: worktree?.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: worktree?.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: worktree?.linkedGiteaPR ?? null
    }),
    [worktree]
  )
  const remoteInferred = parseRemoteRepo(repo?.gitRemoteIdentity?.remoteUrl ?? '')?.provider ?? null
  const explicit =
    typeof modalReviewProvider === 'string' && supportsHostedReviewCreation(modalReviewProvider)
      ? modalReviewProvider
      : null

  // Why: every source resolveProvisionalHostedReviewProvider consults, before it
  // reaches its hard 'github' default. If none of them holds anything, the default
  // would be a guess — that is the only case worth a round trip to main.
  const hasSyncEvidence =
    supportsHostedReviewCreation(hostedReview?.provider) ||
    Object.values(links).some((value) => value !== null) ||
    supportsHostedReviewCreation(remoteInferred)

  // Why: no repo and folder workspaces are terminal, not pending. A folder
  // workspace has no persisted review slot and the save path drops link keys for
  // it; an unresolvable repo has nothing to detect against. Both render the
  // historical GitHub field rather than an input disabled forever.
  const canAnswer = hasSyncEvidence || detected !== null || isFolderWorkspace || repo === null
  const resolvedProvider = resolveProvisionalHostedReviewProvider({
    hostedReview,
    hostedReviewCreationState:
      detected !== null && repo ? { repoId: repo.id, data: { provider: detected } } : null,
    activeRepoId: repo?.id ?? null,
    linkedGitHubPR: links.linkedPR,
    linkedGitLabMR: links.linkedGitLabMR,
    linkedBitbucketPR: links.linkedBitbucketPR,
    linkedAzureDevOpsPR: links.linkedAzureDevOpsPR,
    linkedGiteaPR: links.linkedGiteaPR,
    remoteInferredProvider: remoteInferred
  })
  const resolved: WorktreeReviewProvider | null =
    explicit ??
    (canAnswer && supportsHostedReviewCreation(resolvedProvider) ? resolvedProvider : null)

  const needsDetection =
    isOpen && resolved === null && repo !== null && repoHostKey !== null && worktree !== undefined

  useEffect(() => {
    if (!needsDetection || !repo || !repoHostKey || !worktree) {
      return
    }
    const memo = detectedProviderByRepoHost.get(repoHostKey)
    if (memo) {
      setDetected(memo)
      return
    }
    let cancelled = false
    // Why: eligibility's `provider` field is detectHostedReviewProvider's answer
    // (main/source-control/hosted-review-creation.ts), which reads the real remote
    // and the glab config — so a self-hosted GitLab resolves where the renderer's
    // host allowlist cannot. The action is already owner-routed and already bounded.
    void getEligibility({
      repoPath: repo.path,
      repoId: repo.id,
      worktreePath: worktree.path,
      branch: worktree.branch
    })
      .then((eligibility) => {
        if (!supportsHostedReviewCreation(eligibility.provider)) {
          return null
        }
        // Why: remember only a real answer. A timeout, an offline SSH host or an
        // unauthenticated glab is not evidence about the provider — caching the
        // fallback would pin a GitLab repo to a GitHub field for the whole session,
        // which is the bug this change exists to fix.
        detectedProviderByRepoHost.set(repoHostKey, eligibility.provider)
        return eligibility.provider
      })
      .catch(() => null)
      .then((provider) => {
        if (!cancelled) {
          setDetected(provider ?? 'github')
        }
      })
    return () => {
      cancelled = true
    }
  }, [getEligibility, needsDetection, repo, repoHostKey, worktree])

  return {
    provider: resolved,
    isResolving: resolved === null,
    // Why: the slot for the provider being edited, read directly. Going through
    // getWorktreeCardPrDisplay would return the *display* precedence winner, which
    // is a different number whenever an explicit provider overrides it — and an
    // empty baseline is how the comment-only-save bug comes back.
    persistedReview: resolved ? (getLinkedReviewNumber(resolved, links)?.toString() ?? '') : ''
  }
}
