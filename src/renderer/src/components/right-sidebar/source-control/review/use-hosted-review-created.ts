import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { translate } from '@/i18n/i18n'
import { resolveCreatedHostedReviewLink } from '../../source-control-created-review-link'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlStatusRefresh } from '../sync/use-status-refresh'
import type { SourceControlLinkedReviews } from './use-linked-reviews'
import type {
  CreatedHostedReview,
  HostedReviewCreatedContext
} from './hosted-review-creation-state'

/**
 * Settles a freshly created hosted review: pins the link onto the worktree, force-refreshes the
 * review caches, and (unless suppressed) reveals it in the Checks tab.
 */
export function useSourceControlHostedReviewCreated({
  activeRepo,
  activeWorktreeId,
  branchName,
  fallbackGitHubPRNumber,
  fetchHostedReviewForBranch,
  fetchPRForBranch,
  linkedAzureDevOpsPR,
  linkedBitbucketPR,
  linkedGitHubPR,
  linkedGitLabMR,
  linkedGiteaPR,
  refreshActiveGitStatusAfterMutation,
  setRightSidebarOpen,
  setRightSidebarTab,
  updateWorktreeMeta
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeWorktreeId: string | null
  branchName: string
  fallbackGitHubPRNumber: SourceControlLinkedReviews['fallbackGitHubPRNumber']
  fetchHostedReviewForBranch: SourceControlStoreActions['fetchHostedReviewForBranch']
  fetchPRForBranch: SourceControlStoreActions['fetchPRForBranch']
  linkedAzureDevOpsPR: SourceControlLinkedReviews['linkedAzureDevOpsPR']
  linkedBitbucketPR: SourceControlLinkedReviews['linkedBitbucketPR']
  linkedGitHubPR: SourceControlLinkedReviews['linkedGitHubPR']
  linkedGitLabMR: SourceControlLinkedReviews['linkedGitLabMR']
  linkedGiteaPR: SourceControlLinkedReviews['linkedGiteaPR']
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  setRightSidebarOpen: SourceControlStoreActions['setRightSidebarOpen']
  setRightSidebarTab: SourceControlStoreActions['setRightSidebarTab']
  updateWorktreeMeta: SourceControlStoreActions['updateWorktreeMeta']
}) {
  const handlePullRequestCreated = useCallback(
    async (result: CreatedHostedReview, context?: HostedReviewCreatedContext): Promise<void> => {
      const repoPath = context?.repoPath ?? activeRepo?.path
      const repoId = context?.repoId ?? activeRepo?.id
      const branch = context?.branch ?? branchName
      const worktreeId = context?.worktreeId ?? activeWorktreeId ?? null
      const openChecks = context?.openChecks ?? true
      if (!repoPath || !repoId || !branch) {
        return
      }
      const copy = localizedHostedReviewCopy(
        resolveSupportedHostedReviewCopyProvider(result.provider)
      )
      if (openChecks) {
        setRightSidebarOpen(true)
        setRightSidebarTab('checks')
      }
      try {
        const createdLink = resolveCreatedHostedReviewLink(result.provider, result.number)
        if (worktreeId && result.provider !== 'unsupported') {
          await updateWorktreeMeta(worktreeId, createdLink.worktree)
        }
        const linkedReviewNumbers = {
          linkedGitHubPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR,
          ...createdLink.lookup
        }
        if (result.provider === 'gitlab') {
          await fetchHostedReviewForBranch(repoPath, branch, {
            force: true,
            repoId,
            ...linkedReviewNumbers
          })
          return
        }
        if (result.provider !== 'github') {
          await fetchHostedReviewForBranch(repoPath, branch, {
            force: true,
            repoId,
            ...linkedReviewNumbers
          })
          return
        }
        await Promise.all([
          fetchHostedReviewForBranch(repoPath, branch, {
            force: true,
            repoId,
            ...linkedReviewNumbers
          }),
          fetchPRForBranch(repoPath, branch, {
            force: true,
            repoId,
            worktreeId: worktreeId ?? undefined,
            linkedPRNumber: result.number
          })
        ])
      } catch {
        toast.warning(
          translate(
            'auto.components.right.sidebar.SourceControl.0453ca3a9a',
            '{{value0}} created, but Orca could not refresh it yet.',
            { value0: copy.titleLabel }
          ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.SourceControl.812cb992ee',
                'Open on {{value0}}',
                { value0: copy.providerName }
              ),
              onClick: () => window.api.shell.openUrl(result.url)
            }
          }
        )
      }
    },
    [
      activeRepo,
      activeWorktreeId,
      branchName,
      fallbackGitHubPRNumber,
      fetchHostedReviewForBranch,
      fetchPRForBranch,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitHubPR,
      linkedGitLabMR,
      setRightSidebarOpen,
      setRightSidebarTab,
      updateWorktreeMeta
    ]
  )

  const openHostedReviewInChecks = useCallback(() => {
    setRightSidebarOpen(true)
    setRightSidebarTab('checks')
  }, [setRightSidebarOpen, setRightSidebarTab])

  const handleBranchChangedByPullRequestGeneration = useCallback(async (): Promise<void> => {
    // Why: AI PR detail generation may rebase before summarizing, so refresh status if HEAD moved before the user submits the draft.
    await refreshActiveGitStatusAfterMutation()
  }, [refreshActiveGitStatusAfterMutation])

  return {
    handleBranchChangedByPullRequestGeneration,
    handlePullRequestCreated,
    openHostedReviewInChecks
  }
}

export type SourceControlHostedReviewCreated = ReturnType<
  typeof useSourceControlHostedReviewCreated
>
