import { useCallback } from 'react'
import { toast } from 'sonner'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { openHttpLink } from '@/lib/http-link-routing'
import { resolveCreatedHostedReviewLink } from '../source-control-created-review-link'
import { formatCreateError } from '../create-pull-request-review-copy'
import { stripBaseRef } from '../create-pull-request-base-ref-normalization'
import { normalizeHostedReviewHeadRef } from '../../../../../shared/hosted-review-refs'
import {
  hostedReviewProviderSupportsDraft,
  type HostedReviewProvider
} from '../../../../../shared/hosted-review'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelPollingState } from './use-checks-panel-polling'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import type { ChecksPanelBranchActionsState } from './use-checks-panel-branch-actions'
import type { ChecksPanelCheckAndReviewActionsState } from './use-checks-panel-check-and-review-actions'
import { clearPullRequestGenerationRequiresPushBeforeCreate } from '@/store/slices/pull-request-generation'
import { translate } from '@/i18n/i18n'

type ChecksPanelCreateReviewInput = Pick<
  ChecksPanelReviewState,
  | 'activePullRequestGenerationKey'
  | 'createComposerOpen'
  | 'createPrPushFirst'
  | 'hostedReviewCreateCopy'
  | 'hostedReviewCreateProvider'
  | 'hostedReviewCreation'
  | 'prCreationDefaults'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktreeId'
    | 'activeWorktreePath'
    | 'branch'
    | 'createHostedReview'
    | 'createPrInFlightRef'
    | 'createStackedHostedReview'
    | 'fetchHostedReviewForBranch'
    | 'panelContextKey'
    | 'panelContextKeyRef'
    | 'repo'
    | 'setCreatePrError'
    | 'setGitStatusRefreshNonce'
    | 'setIsCreatingPr'
    | 'setRightSidebarOpen'
    | 'setRightSidebarTab'
    | 'updatePullRequestGenerationRecord'
    | 'updateWorktreeMeta'
  > &
  Pick<
    ChecksPanelContextState,
    | 'fallbackGitHubPRNumber'
    | 'linkedAzureDevOpsPR'
    | 'linkedBitbucketPR'
    | 'linkedGiteaPR'
    | 'linkedGitLabMR'
    | 'linkedPR'
  > &
  Pick<ChecksPanelPollingState, 'fetchGitLabDetails'> &
  Pick<ChecksPanelComposerState, 'prBase' | 'prBody' | 'prDraft' | 'prGenerating' | 'prTitle'> &
  Pick<ChecksPanelBranchActionsState, 'pushBeforeCreatePullRequest'> &
  Pick<ChecksPanelCheckAndReviewActionsState, 'refreshLinkedGitHubPullRequest'>

export function useChecksPanelCreateReview(model: ChecksPanelCreateReviewInput) {
  const {
    activePullRequestGenerationKey,
    activeWorktreeId,
    activeWorktreePath,
    branch,
    createComposerOpen,
    createHostedReview,
    createPrInFlightRef,
    createPrPushFirst,
    createStackedHostedReview,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    hostedReviewCreateCopy,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    panelContextKey,
    panelContextKeyRef,
    prBase,
    prBody,
    prCreationDefaults,
    prDraft,
    prGenerating,
    prTitle,
    pushBeforeCreatePullRequest,
    refreshLinkedGitHubPullRequest,
    repo,
    setCreatePrError,
    setGitStatusRefreshNonce,
    setIsCreatingPr,
    setRightSidebarOpen,
    setRightSidebarTab,
    updatePullRequestGenerationRecord,
    updateWorktreeMeta
  } = model
  const handlePullRequestCreated = useCallback(
    async (result: {
      provider: HostedReviewProvider
      number: number
      url: string
    }): Promise<void> => {
      if (!repo || !branch) {
        return
      }
      setRightSidebarOpen(true)
      setRightSidebarTab('checks')
      try {
        const createdLink = resolveCreatedHostedReviewLink(result.provider, result.number)
        if (activeWorktreeId && result.provider !== 'unsupported') {
          await updateWorktreeMeta(activeWorktreeId, createdLink.worktree)
        }
        const linkedReviewNumbers = {
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR,
          ...createdLink.lookup
        }
        if (result.provider === 'gitlab') {
          const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
            repoPath: repo.path,
            repoId: repo.id,
            branch,
            ...linkedReviewNumbers
          })
          const refreshedGitLabReview =
            refreshedReview?.provider === 'gitlab' ? refreshedReview : null
          await fetchGitLabDetails({
            mrNumberOverride: result.number,
            headShaOverride: refreshedGitLabReview?.headSha,
            commitAsCurrent: true
          })
          return
        }
        if (result.provider !== 'github') {
          await refreshHostedReviewCard(fetchHostedReviewForBranch, {
            repoPath: repo.path,
            repoId: repo.id,
            branch,
            ...linkedReviewNumbers
          })
          return
        }
        await refreshLinkedGitHubPullRequest(result.number)
      } catch {
        // The success toast keeps the hosted URL available; Checks can be refreshed manually.
      }
    },
    [
      branch,
      fallbackGitHubPRNumber,
      fetchGitLabDetails,
      fetchHostedReviewForBranch,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitLabMR,
      linkedPR,
      refreshLinkedGitHubPullRequest,
      repo,
      setRightSidebarOpen,
      setRightSidebarTab,
      activeWorktreeId,
      updateWorktreeMeta
    ]
  )

  const handleCreatePullRequest = useCallback(
    async (stacked = false): Promise<void> => {
      if (!repo || !branch || !createComposerOpen || prGenerating || createPrInFlightRef.current) {
        return
      }

      const requestContextKey = panelContextKey
      const isCurrentCreateRequest = (): boolean =>
        panelContextKeyRef.current === requestContextKey &&
        createPrInFlightRef.current === requestContextKey
      const base = stripBaseRef(prBase).trim()
      const title = prTitle.trim()
      const worktreePath = activeWorktreePath ?? repo.path
      if (!title) {
        setCreatePrError(
          translate(
            'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
            'Enter a {{value0}} title.',
            {
              value0: hostedReviewCreateCopy.reviewLabel
            }
          )
        )
        return
      }
      if (!base || stripBaseRef(base).toLowerCase() === stripBaseRef(branch).toLowerCase()) {
        setCreatePrError(
          translate(
            'auto.components.right.sidebar.SourceControl.ae743199cd',
            'Choose a different base branch before creating a {{value0}}.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        )
        return
      }

      createPrInFlightRef.current = requestContextKey
      setIsCreatingPr(true)
      setCreatePrError(null)
      let pushed = false
      try {
        const shouldPushBeforeCreate =
          createPrPushFirst || hostedReviewCreation?.blockedReason === 'needs_push'
        if (shouldPushBeforeCreate) {
          const ok = await pushBeforeCreatePullRequest()
          if (!isCurrentCreateRequest()) {
            return
          }
          if (!ok) {
            setCreatePrError('Push failed. Resolve the push error, then try again.')
            return
          }
          pushed = true
        }
        const createInput = {
          repoId: repo.id,
          provider: hostedReviewCreateProvider,
          base,
          head: normalizeHostedReviewHeadRef(branch),
          title,
          body: prBody,
          draft: prDraft && hostedReviewProviderSupportsDraft(hostedReviewCreateProvider),
          worktreePath,
          useTemplate: prCreationDefaults.useTemplate
        }
        const result = stacked
          ? await createStackedHostedReview(repo.path, createInput)
          : await createHostedReview(repo.path, createInput)
        if (!isCurrentCreateRequest()) {
          return
        }
        if (result.ok) {
          await handlePullRequestCreated({
            provider: hostedReviewCreateProvider,
            number: result.number,
            url: result.url
          })
          if (prCreationDefaults.openAfterCreate) {
            openHttpLink(result.url, { worktreeId: activeWorktreeId })
          }
          if (activePullRequestGenerationKey) {
            updatePullRequestGenerationRecord(
              activePullRequestGenerationKey,
              clearPullRequestGenerationRequiresPushBeforeCreate
            )
          }
          return
        }
        if ('existingReview' in result && result.existingReview?.url) {
          const number = result.existingReview.number
          toast.success(
            number
              ? translate(
                  'auto.components.right.sidebar.ChecksPanel.b6ce28da5b',
                  '{{value0}} #{{value1}} is already open',
                  { value0: hostedReviewCreateCopy.titleLabel, value1: number }
                )
              : translate(
                  'auto.components.right.sidebar.ChecksPanel.cf9e69f3be',
                  '{{value0}} is already open',
                  { value0: hostedReviewCreateCopy.titleLabel }
                ),
            {
              action: {
                label: translate(
                  'auto.components.right.sidebar.ChecksPanel.192e686e57',
                  'Open on {{value0}}',
                  { value0: hostedReviewCreateCopy.providerName }
                ),
                onClick: () => window.api.shell.openUrl(result.existingReview!.url)
              }
            }
          )
          if (number) {
            await handlePullRequestCreated({
              provider: hostedReviewCreateProvider,
              number,
              url: result.existingReview.url
            })
            if (activePullRequestGenerationKey) {
              updatePullRequestGenerationRecord(
                activePullRequestGenerationKey,
                clearPullRequestGenerationRequiresPushBeforeCreate
              )
            }
            return
          }
        }
        // Why: stacked creation can create the pull request and still fail to register
        // the stack. Link the review that exists before surfacing the stack failure, or
        // the workspace stays unaware of a PR the user can already see on GitHub.
        if ('createdReview' in result && result.createdReview?.url) {
          const { number, url } = result.createdReview
          if (number) {
            await handlePullRequestCreated({
              provider: hostedReviewCreateProvider,
              number,
              url
            })
          }
        }
        setCreatePrError(formatCreateError(result, pushed, hostedReviewCreateCopy.shortLabel))
      } catch (error) {
        if (!isCurrentCreateRequest()) {
          return
        }
        setCreatePrError(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.right.sidebar.SourceControl.e2b7a1c0d9f4',
                'Failed to create {{value0}}',
                { value0: hostedReviewCreateCopy.reviewLabel }
              )
        )
      } finally {
        if (createPrInFlightRef.current === requestContextKey) {
          createPrInFlightRef.current = null
          setIsCreatingPr(false)
          setGitStatusRefreshNonce((value) => value + 1)
        }
      }
    },
    [
      activeWorktreePath,
      activeWorktreeId,
      activePullRequestGenerationKey,
      branch,
      createComposerOpen,
      createHostedReview,
      createStackedHostedReview,
      createPrPushFirst,
      handlePullRequestCreated,
      hostedReviewCreateCopy.providerName,
      hostedReviewCreateCopy.reviewLabel,
      hostedReviewCreateCopy.shortLabel,
      hostedReviewCreateCopy.titleLabel,
      hostedReviewCreateProvider,
      hostedReviewCreation?.blockedReason,
      panelContextKey,
      prBase,
      prBody,
      prCreationDefaults.openAfterCreate,
      prCreationDefaults.useTemplate,
      prDraft,
      prGenerating,
      prTitle,
      pushBeforeCreatePullRequest,
      repo,
      updatePullRequestGenerationRecord,
      setIsCreatingPr,
      setGitStatusRefreshNonce,
      createPrInFlightRef,
      panelContextKeyRef,
      setCreatePrError
    ]
  )
  return { handlePullRequestCreated, handleCreatePullRequest }
}

export type ChecksPanelCreateReviewState = ReturnType<typeof useChecksPanelCreateReview>
