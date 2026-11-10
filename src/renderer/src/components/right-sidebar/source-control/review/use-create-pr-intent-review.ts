import { resolveSourceControlAiPrCreationDefaults } from '../../../../../../shared/source-control/ai/source-control-ai-operation-policy'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorkspaceJiraIssueKey,
  prefixJiraReviewTitle
} from '../../../../../../shared/jira/jira-review-title'
import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { operationGitContext } from '../listing/operation-target'
import { translate } from '@/i18n/i18n'
import { generateRuntimePullRequestFields } from '@/runtime/source-control/git/runtime-git-generation-client'
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
import {
  createPrIntentRunIsCurrent,
  setCreatePrIntentNotice
} from '../panel/worktree-operation-store'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

/** Resolve unattended review fields without a composer; reveal only while the run owns the foreground worktree. */
export function useSourceControlCreatePrIntentReview({
  activeRepo,
  createHostedReview,
  getCreatePrIntentOperationTarget,
  handlePullRequestCreated,
  hostedReviewCreateCopy,
  operationStore,
  prBase,
  prImageUploadPendingRef,
  prBody
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
        setCreatePrIntentNotice(operationStore, {
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
        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.ae743199cd',
            'Choose a different base branch before creating a {{value0}}.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return false
      }

      const currentDefaults = resolveSourceControlAiPrCreationDefaults({
        settings: useAppStore.getState().settings ?? {},
        repo: activeRepo
      })
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
        draft: currentDefaults.draft
      }

      if (
        shouldGenerateHostedReviewDetailsForIntent(eligibility) &&
        hasConfiguredSourceControlTextGenerationDefaults({
          actionId: 'pullRequest',
          settings: useAppStore.getState().settings,
          repo: activeRepo
        })
      ) {
        setCreatePrIntentNotice(operationStore, {
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
              useTemplate: currentDefaults.useTemplate
            }
          )
          if (generated.branchChangedByPreparation) {
            setCreatePrIntentNotice(operationStore, {
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
            setCreatePrIntentNotice(operationStore, {
              tone: 'destructive',
              message: resolved.error
            })
            return false
          }
          fields = resolved.fields
        } catch (error) {
          console.warn('[SourceControl] Create PR intent detail generation failed', error)
          setCreatePrIntentNotice(operationStore, {
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

      if (imagesPending() || !createPrIntentRunIsCurrent(operationStore, token)) {
        return false
      }
      const createPrIntentIsForeground = (): boolean =>
        createPrIntentRunTokenMatches(token, operationStore.getState().createPrIntentTarget)

      const title = prefixJiraReviewTitle(fields.title, jiraIssueKey).trim()
      if (!title) {
        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
            'Enter a {{value0}} title.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return false
      }

      setCreatePrIntentNotice(operationStore, {
        tone: 'muted',
        message: translate(
          'auto.components.right.sidebar.SourceControl.createPrIntentCreatingReview',
          'Creating review…'
        )
      })
      operationStore.setState({ isCreatingPr: true })
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
          useTemplate: currentDefaults.useTemplate
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
          if (openChecks && currentDefaults.openAfterCreate) {
            openAppHttpLink(result.url, { worktreeId: token.worktreeId })
          }
          setCreatePrIntentNotice(operationStore, null)
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
          setCreatePrIntentNotice(operationStore, null)
          return true
        }

        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message: localizedCreateFailure(result, eligibility.provider)
        })
        return false
      } catch (error) {
        const message = localizedCreateException(error, hostedReviewCreateCopy.reviewLabel)
        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message
        })
        return false
      } finally {
        operationStore.setState({ isCreatingPr: false })
      }
    },
    [
      activeRepo,
      createHostedReview,
      getCreatePrIntentOperationTarget,
      handlePullRequestCreated,
      hostedReviewCreateCopy.reviewLabel,
      operationStore,
      prBase,
      prImageUploadPendingRef,
      prBody
    ]
  )

  return { createHostedReviewForCreatePrIntent }
}

export type SourceControlCreatePrIntentReview = ReturnType<
  typeof useSourceControlCreatePrIntentReview
>
