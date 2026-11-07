import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorkspaceJiraIssueKey,
  prefixJiraReviewTitle
} from '../../../../../../shared/jira/jira-review-title'
import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { operationGitContext } from '../listing/operation-target'
import { translate } from '@/i18n/i18n'
import { generateRuntimePullRequestFields } from '@/runtime/runtime-git-generation-client'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  localizedCreateFailure,
  localizedCreateException
} from '../../hosted-review/provider-actions/hosted-review-create-failure-copy'
import {
  normalizeHostedReviewHeadRef,
  normalizeHostedReviewBaseRef as stripBaseRef
} from '../../../../../../shared/source-control/hosted-review/hosted-review-refs'
import { resolveCreateReviewSeedText } from '../../../../../../shared/source-control/hosted-review/hosted-review-create-seed'
import {
  createPrIntentRunTokenMatches,
  resolveCreatePrIntentGeneratedReviewFields,
  resolveCreatePrIntentReviewBase,
  shouldAttemptCreateHostedReviewForIntent,
  shouldAttemptCreateHostedReviewForIntent as shouldGenerateHostedReviewDetailsForIntent,
  type CreatePrIntentReviewOptions,
  type CreatePrIntentRunToken
} from './create-pr-intent-flow'
import { hasConfiguredSourceControlTextGenerationDefaults } from '../ai/text-generation-defaults'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

/** Resolve unattended review fields without a composer; reveal only while the run owns the foreground worktree. */
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
  prImageUploadPendingRef,
  prBody,
  resolvedPrCreationDefaults,
  setCreatePrInFlightByWorktree,
  setCreatePrIntentNoticeForWorktree,
  settings
}: CreatePrIntentReviewOptions) {
  const createHostedReviewForCreatePrIntent = useCallback(
    async (
      token: CreatePrIntentRunToken,
      eligibility: HostedReviewCreationEligibility
    ): Promise<boolean> => {
      const imagesPending = (): boolean => {
        if (!prImageUploadPendingRef?.current) {
          return false
        }
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'muted',
          message: translate(
            'github.waitForImageUploads',
            'Wait for images to finish uploading, then retry Create PR.'
          )
        })
        return true
      }
      if (
        imagesPending() ||
        !activeRepo ||
        !token.branch ||
        !shouldAttemptCreateHostedReviewForIntent(eligibility)
      ) {
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

      const jiraIssueKey =
        eligibility.provider === 'github' || eligibility.provider === 'gitlab'
          ? getWorkspaceJiraIssueKey(
              useAppStore
                .getState()
                .getKnownWorktreeById(token.worktreeId, getRepoExecutionHostId(activeRepo))
            )
          : null
      let fields = {
        base,
        title: resolveCreateReviewSeedText({ branch: token.branch, eligibility, jiraIssueKey })
          .title,
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
          const generated = await generateRuntimePullRequestFields(
            operationGitContext(target, useAppStore.getState().settings),
            {
              ...fields,
              provider: eligibility.provider,
              useTemplate: resolvedPrCreationDefaults.useTemplate
            }
          )
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
              message: resolved.error
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
        imagesPending() ||
        !createPrIntentRunStillOwnsWorktree(token) ||
        createPrIntentActiveTargetConflicts(token)
      ) {
        return false
      }
      const createPrIntentIsForeground = (): boolean =>
        createPrIntentRunTokenMatches(token, createPrIntentCurrentTargetRef.current)

      const title = prefixJiraReviewTitle(fields.title, jiraIssueKey).trim()
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
            openAppHttpLink(result.url, { worktreeId: token.worktreeId })
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
          message: localizedCreateFailure(result, eligibility.provider)
        })
        return false
      } catch (error) {
        const message = localizedCreateException(error, hostedReviewCreateCopy.reviewLabel)
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
      prImageUploadPendingRef,
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
