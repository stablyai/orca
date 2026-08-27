import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { generateRuntimePullRequestFields } from '@/runtime/runtime-git-client'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/hosted-review'
import { normalizeHostedReviewHeadRef } from '../../../../../../shared/hosted-review-refs'
import { resolveCreateReviewDraftTitle } from '../../create-review-draft-title'
import {
  createPrIntentRunTokenMatches,
  resolveCreatePrIntentGeneratedReviewFields,
  resolveCreatePrIntentReviewBase,
  shouldAttemptCreateHostedReviewForIntent,
  shouldGenerateHostedReviewDetailsForIntent,
  type CreatePrIntentRunToken
} from './create-pr-intent-flow'
import { hasConfiguredSourceControlTextGenerationDefaults } from '../ai/text-generation-defaults'
import type { SourceControlAi } from '../ai/use-ai'
import { stripBaseRef } from '../../create-pull-request-base-ref-normalization'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import type { SourceControlCreateReviewComposer } from './use-create-review-composer'
import type { SourceControlHostedReviewCreated } from './use-hosted-review-created'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'

/**
 * Create-PR intent's unattended review step: it must resolve its own base/title/body (no composer to
 * read) and only reveal the result when the run still owns the foreground worktree.
 */
export function useSourceControlCreatePrIntentReview({
  activeRepo,
  createHostedReview,
  createPrInFlightRef,
  createPrIntentActiveTargetConflicts,
  createPrIntentCurrentTargetRef,
  createPrIntentRunStillOwnsWorktree,
  getCreatePrIntentOperationTarget,
  handlePullRequestCreated,
  hostedReviewCreateCopy,
  prBase,
  prBody,
  resolvedPrCreationDefaults,
  setCreatePrInFlightByWorktree,
  setCreatePrIntentNoticeForWorktree,
  settings
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  createHostedReview: SourceControlStoreActions['createHostedReview']
  createPrInFlightRef: SourceControlWorktreeOperationState['createPrInFlightRef']
  createPrIntentActiveTargetConflicts: SourceControlWorktreeOperationState['createPrIntentActiveTargetConflicts']
  createPrIntentCurrentTargetRef: SourceControlWorktreeOperationState['createPrIntentCurrentTargetRef']
  createPrIntentRunStillOwnsWorktree: SourceControlWorktreeOperationState['createPrIntentRunStillOwnsWorktree']
  getCreatePrIntentOperationTarget: SourceControlCreatePrIntentTarget['getCreatePrIntentOperationTarget']
  handlePullRequestCreated: SourceControlHostedReviewCreated['handlePullRequestCreated']
  hostedReviewCreateCopy: SourceControlHostedReviewState['hostedReviewCreateCopy']
  prBase: SourceControlCreateReviewComposer['prBase']
  prBody: SourceControlCreateReviewComposer['prBody']
  resolvedPrCreationDefaults: SourceControlAi['resolvedPrCreationDefaults']
  setCreatePrInFlightByWorktree: SourceControlWorktreeOperationState['setCreatePrInFlightByWorktree']
  setCreatePrIntentNoticeForWorktree: SourceControlWorktreeOperationState['setCreatePrIntentNoticeForWorktree']
  settings: SourceControlWorktreeContext['settings']
}) {
  const createHostedReviewForCreatePrIntent = useCallback(
    async (
      token: CreatePrIntentRunToken,
      eligibility: HostedReviewCreationEligibility
    ): Promise<boolean> => {
      if (!activeRepo || !token.branch || !shouldAttemptCreateHostedReviewForIntent(eligibility)) {
        return false
      }

      const base = resolveCreatePrIntentReviewBase({
        currentBaseRef: token.baseRef,
        eligibilityDefaultBaseRef: eligibility.defaultBaseRef,
        composerBaseRef: prBase
      }).trim()
      if (!base || stripBaseRef(base).toLowerCase() === stripBaseRef(token.branch).toLowerCase()) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.ae743199cd',
            'Choose a different base branch before creating a {{value0}}.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return false
      }

      let fields = {
        base,
        title: resolveCreateReviewDraftTitle({
          branch: token.branch,
          eligibilityTitle: eligibility.title
        }),
        body: eligibility.body ?? prBody,
        draft: resolvedPrCreationDefaults.draft
      }

      if (
        shouldGenerateHostedReviewDetailsForIntent(eligibility) &&
        hasConfiguredSourceControlTextGenerationDefaults({
          actionId: 'pullRequest',
          settings,
          repo: activeRepo
        })
      ) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'muted',
          message: translate(
            'auto.components.right.sidebar.SourceControl.createPrIntentGeneratingDetails',
            'Generating review details…'
          )
        })
        const target = getCreatePrIntentOperationTarget(token)
        try {
          const generated = await generateRuntimePullRequestFields(target, {
            ...fields,
            provider: eligibility.provider,
            useTemplate: resolvedPrCreationDefaults.useTemplate
          })
          if (generated.branchChangedByPreparation) {
            setCreatePrIntentNoticeForWorktree(token.worktreeId, {
              tone: 'muted',
              message: translate(
                'auto.components.right.sidebar.SourceControl.createPrIntentBranchChangedDuringDetails',
                'Branch changed while generating review details. Retry Create PR.'
              )
            })
            return false
          }
          const resolved = resolveCreatePrIntentGeneratedReviewFields(fields, generated)
          if (!resolved.ok) {
            setCreatePrIntentNoticeForWorktree(token.worktreeId, {
              tone: 'destructive',
              message:
                resolved.error ??
                translate(
                  'auto.components.right.sidebar.SourceControl.createPrIntentEmptyGeneratedBody',
                  'Generated review details did not include a description. Retry Create PR.'
                )
            })
            return false
          }
          fields = resolved.fields
        } catch (error) {
          console.warn('[SourceControl] Create PR intent detail generation failed', error)
          setCreatePrIntentNoticeForWorktree(token.worktreeId, {
            tone: 'destructive',
            message:
              error instanceof Error
                ? error.message
                : translate(
                    'auto.components.right.sidebar.SourceControl.createPrIntentGenerateDetailsFailed',
                    'Could not generate review details. Retry Create PR.'
                  )
          })
          return false
        }
      }

      if (
        !createPrIntentRunStillOwnsWorktree(token) ||
        createPrIntentActiveTargetConflicts(token)
      ) {
        return false
      }
      const createPrIntentIsForeground = (): boolean =>
        createPrIntentRunTokenMatches(token, createPrIntentCurrentTargetRef.current)

      const title = fields.title.trim()
      if (!title) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
            'Enter a {{value0}} title.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return false
      }

      setCreatePrIntentNoticeForWorktree(token.worktreeId, {
        tone: 'muted',
        message: translate(
          'auto.components.right.sidebar.SourceControl.createPrIntentCreatingReview',
          'Creating review…'
        )
      })
      createPrInFlightRef.current[token.worktreeId] = true
      setCreatePrInFlightByWorktree((prev) => ({ ...prev, [token.worktreeId]: true }))
      try {
        const result = await createHostedReview(activeRepo.path, {
          repoId: activeRepo.id,
          provider: eligibility.provider,
          base: fields.base,
          head: normalizeHostedReviewHeadRef(token.branch),
          title,
          body: fields.body,
          draft: fields.draft,
          worktreePath: token.worktreePath,
          useTemplate: resolvedPrCreationDefaults.useTemplate
        })

        if (result.ok) {
          const openChecks = createPrIntentIsForeground()
          await handlePullRequestCreated(
            {
              provider: eligibility.provider,
              number: result.number,
              url: result.url
            },
            {
              repoPath: activeRepo.path,
              repoId: activeRepo.id,
              branch: token.branch,
              worktreeId: token.worktreeId,
              openChecks
            }
          )
          if (openChecks && resolvedPrCreationDefaults.openAfterCreate) {
            window.api.shell.openUrl(result.url)
          }
          setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
          return true
        }

        if (result.existingReview?.number && result.existingReview.url) {
          const openChecks = createPrIntentIsForeground()
          await handlePullRequestCreated(
            {
              provider: eligibility.provider,
              number: result.existingReview.number,
              url: result.existingReview.url
            },
            {
              repoPath: activeRepo.path,
              repoId: activeRepo.id,
              branch: token.branch,
              worktreeId: token.worktreeId,
              openChecks
            }
          )
          setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
          return true
        }

        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: result.error
        })
        return false
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.right.sidebar.SourceControl.e2b7a1c0d9f4',
                'Failed to create {{value0}}',
                { value0: hostedReviewCreateCopy.reviewLabel }
              )
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message
        })
        return false
      } finally {
        createPrInFlightRef.current[token.worktreeId] = false
        setCreatePrInFlightByWorktree((prev) => ({ ...prev, [token.worktreeId]: false }))
      }
    },
    [
      activeRepo,
      createHostedReview,
      createPrInFlightRef,
      createPrIntentActiveTargetConflicts,
      createPrIntentCurrentTargetRef,
      createPrIntentRunStillOwnsWorktree,
      getCreatePrIntentOperationTarget,
      handlePullRequestCreated,
      hostedReviewCreateCopy.reviewLabel,
      prBase,
      prBody,
      resolvedPrCreationDefaults.draft,
      resolvedPrCreationDefaults.openAfterCreate,
      resolvedPrCreationDefaults.useTemplate,
      setCreatePrInFlightByWorktree,
      setCreatePrIntentNoticeForWorktree,
      settings
    ]
  )

  return { createHostedReviewForCreatePrIntent }
}

export type SourceControlCreatePrIntentReview = ReturnType<
  typeof useSourceControlCreatePrIntentReview
>
