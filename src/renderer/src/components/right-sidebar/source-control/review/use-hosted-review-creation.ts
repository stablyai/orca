import { useAppStore } from '@/store'
import { resolveSourceControlAiPrCreationDefaults } from '../../../../../../shared/source-control/ai/source-control-ai-operation-policy'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  normalizeHostedReviewHeadRef,
  normalizeHostedReviewBaseRef as stripBaseRef
} from '../../../../../../shared/source-control/hosted-review/hosted-review-refs'
import { resolveBlockedCreateReviewNoticeMessage } from './source-control-create-review-blocked-action'
import {
  localizedCreateFailure,
  localizedCreateException
} from '../../hosted-review/provider-actions/hosted-review-create-failure-copy'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { setCreatePrIntentNotice } from '../panel/worktree-operation-store'
import type { SourceControlCreateReviewComposer } from './use-create-review-composer'
import type { SourceControlHostedReviewCreated } from './use-hosted-review-created'
import type { HostedReviewCreatedContext } from './hosted-review-creation-state'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import type { SourceControlPullRequestGeneration } from './use-pull-request-generation'
import type { PullRequestGenerationFields } from '@/store/slices/hosted-review/generation/pull-request-generation-state'
import { useGenerateBeforeCreatePullRequest } from '../../hosted-review/creation/use-generate-before-create-pull-request'
import { createdReviewIsForeground } from '../../hosted-review/creation/created-review-foreground'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

/** Already-open and partial-stack failures can leave a real review that still needs linking. */
export function useSourceControlHostedReviewCreation({
  activePullRequestGenerationKey,
  activeRepo,
  activeWorktreeId,
  branchName,
  createHostedReview,
  createStackedHostedReview,
  handleGeneratePullRequestFields,
  handlePullRequestCreated,
  hostedReviewCreateCopy,
  hostedReviewCreateProvider,
  hostedReviewCreation,
  operationStore,
  prAiGenerationEnabled,
  prBase,
  prImageUploadPendingRef,
  prBody,
  prDraft,
  prFieldRevisions,
  prFieldsAreSeedPlaceholders,
  prGenerating,
  prTitle,
  pullRequestFieldsInitialized,
  worktreePath
}: Pick<
  SourceControlCreateReviewComposer,
  | 'prAiGenerationEnabled'
  | 'prBase'
  | 'prBody'
  | 'prDraft'
  | 'prFieldRevisions'
  | 'prFieldsAreSeedPlaceholders'
  | 'prTitle'
  | 'pullRequestFieldsInitialized'
  | 'handleGeneratePullRequestFields'
> & {
  activePullRequestGenerationKey: SourceControlPullRequestGeneration['activePullRequestGenerationKey']
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeWorktreeId: string | null
  branchName: string
  createHostedReview: SourceControlStoreActions['createHostedReview']
  createStackedHostedReview: SourceControlStoreActions['createStackedHostedReview']
  handlePullRequestCreated: SourceControlHostedReviewCreated['handlePullRequestCreated']
  hostedReviewCreateCopy: SourceControlHostedReviewState['hostedReviewCreateCopy']
  hostedReviewCreateProvider: SourceControlHostedReviewState['hostedReviewCreateProvider']
  hostedReviewCreation: SourceControlHostedReviewState['hostedReviewCreation']
  operationStore: SourceControlWorktreeOperationState['operationStore']
  prImageUploadPendingRef?: React.RefObject<boolean>
  prGenerating: boolean
  worktreePath: string | null
}) {
  const createPullRequest = useCallback(
    async (stacked = false, generated?: PullRequestGenerationFields): Promise<void> => {
      if (
        prImageUploadPendingRef?.current ||
        !activeRepo ||
        !activeWorktreeId ||
        !worktreePath ||
        !hostedReviewCreation ||
        prGenerating
      ) {
        return
      }

      if (!hostedReviewCreation.canCreate) {
        // Blocked clicks show inline prerequisite guidance.
        const message = resolveBlockedCreateReviewNoticeMessage(hostedReviewCreation)
        if (message) {
          setCreatePrIntentNotice(operationStore, {
            tone: 'destructive',
            message
          })
        }
        return
      }

      const currentDefaults = resolveSourceControlAiPrCreationDefaults({
        settings: useAppStore.getState().settings ?? {},
        repo: activeRepo
      })
      const fields = generated ?? { base: prBase, title: prTitle, body: prBody, draft: prDraft }
      const base = stripBaseRef(fields.base).trim()
      const title = fields.title.trim()

      if (!title) {
        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
            'Enter a {{value0}} title.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return
      }

      if (!base || stripBaseRef(base).toLowerCase() === stripBaseRef(branchName).toLowerCase()) {
        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.ae743199cd',
            'Choose a different base branch before creating a {{value0}}.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return
      }

      setCreatePrIntentNotice(operationStore, null)
      const createdContext = (): HostedReviewCreatedContext => ({
        repoPath: activeRepo.path,
        repoId: activeRepo.id,
        branch: branchName,
        worktreeId: activeWorktreeId,
        openChecks: createdReviewIsForeground(activeWorktreeId)
      })
      try {
        const createInput = {
          repoId: activeRepo.id,
          provider: hostedReviewCreateProvider,
          base,
          head: normalizeHostedReviewHeadRef(branchName),
          title,
          body: fields.body,
          draft: fields.draft,
          worktreePath,
          useTemplate: currentDefaults.useTemplate
        }
        const result = stacked
          ? await createStackedHostedReview(activeRepo.path, createInput)
          : await createHostedReview(activeRepo.path, createInput)

        if (result.ok) {
          setCreatePrIntentNotice(operationStore, null)
          const context = createdContext()
          await handlePullRequestCreated(
            {
              provider: hostedReviewCreateProvider,
              number: result.number,
              url: result.url
            },
            context
          )
          if (context.openChecks && currentDefaults.openAfterCreate) {
            openAppHttpLink(result.url, { worktreeId: activeWorktreeId })
          }
          return
        }

        if ('existingReview' in result && result.existingReview?.url) {
          const number = result.existingReview.number
          toast.success(
            number
              ? translate(
                  'auto.components.right.sidebar.SourceControl.eef5446523',
                  '{{value0}} #{{value1}} is already open',
                  { value0: hostedReviewCreateCopy.titleLabel, value1: number }
                )
              : translate(
                  'auto.components.right.sidebar.SourceControl.d6fb1df5fe',
                  '{{value0}} is already open',
                  { value0: hostedReviewCreateCopy.titleLabel }
                ),
            {
              action: {
                label: translate(
                  'auto.components.right.sidebar.SourceControl.812cb992ee',
                  'Open on {{value0}}',
                  { value0: hostedReviewCreateCopy.providerName }
                ),
                onClick: () =>
                  openAppHttpLink(result.existingReview!.url, { worktreeId: activeWorktreeId })
              }
            }
          )
          if (number) {
            setCreatePrIntentNotice(operationStore, null)
            await handlePullRequestCreated(
              {
                provider: hostedReviewCreateProvider,
                number,
                url: result.existingReview.url
              },
              createdContext()
            )
            return
          }
        }

        // Link the created review before reporting stack-registration failure so the workspace knows it exists.
        if ('createdReview' in result && result.createdReview?.url) {
          const { number, url } = result.createdReview
          if (number) {
            await handlePullRequestCreated(
              {
                provider: hostedReviewCreateProvider,
                number,
                url
              },
              createdContext()
            )
          }
        }

        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message: localizedCreateFailure(result, hostedReviewCreateProvider)
        })
      } catch (error) {
        setCreatePrIntentNotice(operationStore, {
          tone: 'destructive',
          message: localizedCreateException(error, hostedReviewCreateCopy.reviewLabel)
        })
      }
    },
    [
      activeRepo,
      activeWorktreeId,
      branchName,
      createHostedReview,
      createStackedHostedReview,
      handlePullRequestCreated,
      hostedReviewCreation,
      hostedReviewCreateCopy.providerName,
      hostedReviewCreateCopy.reviewLabel,
      hostedReviewCreateCopy.titleLabel,
      hostedReviewCreateProvider,
      prBase,
      prImageUploadPendingRef,
      prBody,
      prDraft,
      prGenerating,
      prTitle,
      operationStore,
      worktreePath
    ]
  )

  const { handleCreatePullRequest: generateThenCreatePullRequest } =
    useGenerateBeforeCreatePullRequest({
      aiGenerationEnabled: prAiGenerationEnabled,
      canCreate: hostedReviewCreation?.canCreate === true,
      createPullRequest,
      fields: { base: prBase, title: prTitle, body: prBody, draft: prDraft },
      fieldRevisions: prFieldRevisions,
      fieldsInitialized: pullRequestFieldsInitialized,
      fieldsAreSeedPlaceholders: prFieldsAreSeedPlaceholders,
      generatePullRequestFields: handleGeneratePullRequestFields,
      generationKey: activePullRequestGenerationKey,
      repo: activeRepo
    })

  const handleCreatePullRequest = useCallback(
    async (stacked = false): Promise<void> => {
      if (!activeWorktreeId || operationStore.getState().isCreatingPr) {
        return
      }
      // Hold the click through creation so eligibility refreshes cannot close the composer during generation.
      operationStore.setState({ isCreatingPr: true })
      try {
        await generateThenCreatePullRequest(stacked)
      } finally {
        operationStore.setState({ isCreatingPr: false })
      }
    },
    [activeWorktreeId, generateThenCreatePullRequest, operationStore]
  )

  return { handleCreatePullRequest }
}

export type SourceControlHostedReviewCreation = ReturnType<
  typeof useSourceControlHostedReviewCreation
>
