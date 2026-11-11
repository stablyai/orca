import { useCallback, useLayoutEffect } from 'react'
import { useAppStore } from '@/store/index'
import { recordPullRequestGenerationEdits } from '@/store/slices/hosted-review/generation/pull-request-generation'
import type {
  PullRequestFieldRevisions,
  PullRequestGenerationFields
} from '@/store/slices/hosted-review/generation/pull-request-generation-state'
import type { PullRequestGenerationOptions } from '@/store/slices/hosted-review/generation/pull-request-generation-auto-submit'
import type { Repo } from '../../../../../../shared/repo-types'
import type { PullRequestGenerationOutcome } from './create-pull-request-dialog-field-model'
import { hasConfiguredSourceControlTextGenerationDefaults } from '../../source-control/ai/text-generation-defaults'

type CreatePullRequest = (stacked?: boolean, fields?: PullRequestGenerationFields) => Promise<void>

/** Generate before ready-branch creation only for seeded placeholders with a configured PR agent. */
export function useGenerateBeforeCreatePullRequest({
  aiGenerationEnabled,
  canCreate,
  createPullRequest,
  fields,
  fieldRevisions,
  fieldsInitialized,
  fieldsAreSeedPlaceholders,
  generatePullRequestFields,
  generationKey,
  repo
}: {
  aiGenerationEnabled: boolean
  canCreate: boolean
  createPullRequest: CreatePullRequest
  fields: PullRequestGenerationFields
  fieldRevisions: PullRequestFieldRevisions
  fieldsInitialized: boolean
  fieldsAreSeedPlaceholders: boolean
  generatePullRequestFields: (
    overrides: undefined,
    options: PullRequestGenerationOptions
  ) => Promise<PullRequestGenerationOutcome | void>
  generationKey: string | null
  repo: Pick<Repo, 'sourceControlAi'> | null
}) {
  useLayoutEffect(() => {
    if (generationKey && fieldsInitialized) {
      useAppStore
        .getState()
        .updatePullRequestGenerationRecord(generationKey, (record) =>
          recordPullRequestGenerationEdits(record, fields, fieldRevisions)
        )
    }
  }, [generationKey, fields, fieldRevisions, fieldsInitialized])

  const handleCreatePullRequest = useCallback(
    async (stacked = false): Promise<void> => {
      const status = generationKey
        ? useAppStore.getState().pullRequestGenerationRecords[generationKey]?.status
        : undefined
      // Generation publishes the running record before its first await, guarding repeated clicks.
      if (status === 'running') {
        return
      }
      if (
        !generationKey ||
        !canCreate ||
        !aiGenerationEnabled ||
        !fieldsAreSeedPlaceholders ||
        // After failure/Stop, submit visible fields so a broken agent cannot block Create PR.
        status === 'failed' ||
        status === 'canceled' ||
        !hasConfiguredSourceControlTextGenerationDefaults({
          actionId: 'pullRequest',
          settings: useAppStore.getState().settings,
          repo
        })
      ) {
        await createPullRequest(stacked)
        return
      }
      const outcome = await generatePullRequestFields(undefined, { autoSubmit: true })
      if (!outcome) {
        await createPullRequest(stacked)
        return
      }
      if (!outcome.result) {
        return
      }
      await createPullRequest(stacked, outcome.result)
    },
    [
      aiGenerationEnabled,
      canCreate,
      createPullRequest,
      fieldsAreSeedPlaceholders,
      generatePullRequestFields,
      generationKey,
      repo
    ]
  )

  return { handleCreatePullRequest }
}
