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
import { generateRuntimePullRequestFields } from '@/runtime/runtime-git-generation-client'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { localizedCreateFailure } from '../../hosted-review/provider-actions/hosted-review-create-failure-copy'
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
  type CreatePrIntentRunToken
} from './create-pr-intent-flow'
import { hasConfiguredSourceControlTextGenerationDefaults } from '../ai/text-generation-defaults'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import {
  createPrIntentRunIsCurrent,
  setCreatePrIntentNotice
} from '../panel/worktree-operation-store'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import type { SourceControlCreateReviewComposer } from './use-create-review-composer'
import type { SourceControlHostedReviewCreated } from './use-hosted-review-created'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import { openAppHttpLink } from '@/lib/app-http-link-open'

/** Resolve unattended review fields without a composer; reveal only while the run owns the foreground worktree. */
export function useSourceControlCreatePrIntentReview({
  activeRepo,
  createHostedReview,
  getCreatePrIntentOperationTarget,
  handlePullRequestCreated,
  hostedReviewCreateCopy,
  operationStore,
  prBase,
  prBody
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  createHostedReview: SourceControlStoreActions['createHostedReview']
  getCreatePrIntentOperationTarget: SourceControlCreatePrIntentTarget['getCreatePrIntentOperationTarget']
  handlePullRequestCreated: SourceControlHostedReviewCreated['handlePullRequestCreated']
  hostedReviewCreateCopy: SourceControlHostedReviewState['hostedReviewCreateCopy']
  operationStore: SourceControlWorktreeOperationState['operationStore']
  prBase: SourceControlCreateReviewComposer['prBase']
  prBody: SourceControlCreateReviewComposer['prBody']
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

      if (!createPrIntentRunIsCurrent(operationStore, token)) {
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
        const message =
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.right.sidebar.SourceControl.e2b7a1c0d9f4',
                'Failed to create {{value0}}',
                { value0: hostedReviewCreateCopy.reviewLabel }
              )
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
      prBody
    ]
  )

  return { createHostedReviewForCreatePrIntent }
}

export type SourceControlCreatePrIntentReview = ReturnType<
  typeof useSourceControlCreatePrIntentReview
>
