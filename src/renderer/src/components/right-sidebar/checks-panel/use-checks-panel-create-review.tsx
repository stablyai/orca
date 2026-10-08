import { useCallback } from 'react'
import { toast } from 'sonner'
import { openHttpLink } from '@/lib/http-link-routing'
import { formatCreateError } from '../create-pull-request-review-copy'
import { stripBaseRef } from '../create-pull-request-base-ref-normalization'
import { normalizeHostedReviewHeadRef } from '../../../../../shared/hosted-review-refs'
import { hostedReviewProviderSupportsDraft } from '../../../../../shared/hosted-review'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import type { ChecksPanelBranchActionsState } from './use-checks-panel-branch-actions'
import { clearPullRequestGenerationRequiresPushBeforeCreate } from '@/store/slices/pull-request-generation'
import { translate } from '@/i18n/i18n'
import type { PullRequestGenerationFields } from '@/store/slices/pull-request-generation'
import { useGenerateBeforeCreatePullRequest } from '../use-generate-before-create-pull-request'
import { createdReviewIsForeground } from '../created-review-foreground'
import {
  useChecksPanelCreatedReview,
  type ChecksPanelCreatedReviewInput
} from './use-checks-panel-created-review'

type ChecksPanelCreateReviewInput = ChecksPanelCreatedReviewInput &
  Pick<
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
    | 'activeWorktreePath'
    | 'createHostedReview'
    | 'createPrInFlightRef'
    | 'createStackedHostedReview'
    | 'mountedRef'
    | 'ownerSettings'
    | 'panelContextKey'
    | 'panelContextKeyRef'
    | 'setCreatePrError'
    | 'setGitStatusRefreshNonce'
    | 'setIsCreatingPr'
    | 'updatePullRequestGenerationRecord'
  > &
  Pick<ChecksPanelComposerState, 'prBase' | 'prBody' | 'prDraft' | 'prGenerating' | 'prTitle'> &
  Pick<ChecksPanelComposerState, 'handleGeneratePullRequestFields' | 'prAiGenerationEnabled'> &
  Pick<ChecksPanelComposerState, 'prFieldsAreSeedPlaceholders'> &
  Pick<ChecksPanelBranchActionsState, 'pushBeforeCreatePullRequest'>

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
    handleGeneratePullRequestFields,
    hostedReviewCreateCopy,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    ownerSettings,
    panelContextKey,
    panelContextKeyRef,
    prAiGenerationEnabled,
    prBase,
    prBody,
    prCreationDefaults,
    prDraft,
    prFieldsAreSeedPlaceholders,
    prGenerating,
    prTitle,
    pushBeforeCreatePullRequest,
    repo,
    setCreatePrError,
    setGitStatusRefreshNonce,
    setIsCreatingPr,
    updatePullRequestGenerationRecord
  } = model
  const handlePullRequestCreated = useChecksPanelCreatedReview(model)

  const createPullRequest = useCallback(
    async (stacked = false, generated?: PullRequestGenerationFields): Promise<void> => {
      const requestContextKey = panelContextKey
      // Why: a click-owned run can reach here after the panel moved on; it still creates and links the clicked branch's review, and drives only the panel that still shows it.
      const panelShowsRequest = panelContextKeyRef.current === requestContextKey
      if (
        !repo ||
        !branch ||
        !createComposerOpen ||
        prGenerating ||
        (panelShowsRequest && createPrInFlightRef.current)
      ) {
        return
      }
      const isCurrentCreateRequest = (): boolean =>
        panelContextKeyRef.current === requestContextKey &&
        createPrInFlightRef.current === requestContextKey
      const showCreateError = (message: string): void => {
        if (isCurrentCreateRequest()) {
          setCreatePrError(message)
        }
      }
      const fields = generated ?? { base: prBase, title: prTitle, body: prBody, draft: prDraft }
      const base = stripBaseRef(fields.base).trim()
      const title = fields.title.trim()
      const worktreePath = activeWorktreePath ?? repo.path
      const invalidFieldsError = !title
        ? translate(
            'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
            'Enter a {{value0}} title.',
            {
              value0: hostedReviewCreateCopy.reviewLabel
            }
          )
        : !base || stripBaseRef(base).toLowerCase() === stripBaseRef(branch).toLowerCase()
          ? translate(
              'auto.components.right.sidebar.SourceControl.ae743199cd',
              'Choose a different base branch before creating a {{value0}}.',
              { value0: hostedReviewCreateCopy.reviewLabel }
            )
          : null
      if (invalidFieldsError) {
        if (panelShowsRequest) {
          setCreatePrError(invalidFieldsError)
        }
        return
      }

      if (panelShowsRequest) {
        createPrInFlightRef.current = requestContextKey
        setIsCreatingPr(true)
        setCreatePrError(null)
      }
      let pushed = false
      try {
        const shouldPushBeforeCreate =
          createPrPushFirst || hostedReviewCreation?.blockedReason === 'needs_push'
        if (shouldPushBeforeCreate) {
          const ok = await pushBeforeCreatePullRequest()
          if (!ok) {
            showCreateError('Push failed. Resolve the push error, then try again.')
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
          body: fields.body,
          draft: fields.draft && hostedReviewProviderSupportsDraft(hostedReviewCreateProvider),
          worktreePath,
          useTemplate: prCreationDefaults.useTemplate
        }
        const result = stacked
          ? await createStackedHostedReview(repo.path, createInput)
          : await createHostedReview(repo.path, createInput)
        // Why: read before linking, which changes the panel's context key.
        const panelShowsReview = model.mountedRef.current && isCurrentCreateRequest()
        if (result.ok) {
          const foreground = createdReviewIsForeground(activeWorktreeId, panelShowsReview)
          await handlePullRequestCreated(
            { provider: hostedReviewCreateProvider, number: result.number, url: result.url },
            panelShowsReview
          )
          if (prCreationDefaults.openAfterCreate && foreground) {
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
            await handlePullRequestCreated(
              { provider: hostedReviewCreateProvider, number, url: result.existingReview.url },
              panelShowsReview
            )
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
            await handlePullRequestCreated(
              { provider: hostedReviewCreateProvider, number, url },
              panelShowsReview
            )
          }
        }
        showCreateError(formatCreateError(result, pushed, hostedReviewCreateCopy.shortLabel))
      } catch (error) {
        showCreateError(
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
      model.mountedRef,
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
  const { handleCreatePullRequest } = useGenerateBeforeCreatePullRequest({
    aiGenerationEnabled: prAiGenerationEnabled,
    canCreate: createComposerOpen,
    createPullRequest,
    fieldsAreSeedPlaceholders: prFieldsAreSeedPlaceholders,
    generatePullRequestFields: handleGeneratePullRequestFields,
    generationKey: activePullRequestGenerationKey,
    repo,
    settings: ownerSettings
  })
  return { handlePullRequestCreated, handleCreatePullRequest }
}

export type ChecksPanelCreateReviewState = ReturnType<typeof useChecksPanelCreateReview>
