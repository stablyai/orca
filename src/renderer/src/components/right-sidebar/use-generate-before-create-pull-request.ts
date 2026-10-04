import { useCallback } from 'react'
import { useAppStore, type AppState } from '@/store'
import type { PullRequestGenerationFields } from '@/store/slices/pull-request-generation'
import type { PullRequestGenerationOptions } from '@/store/slices/pull-request-generation-auto-submit'
import type { Repo } from '../../../../shared/repo-types'
import type { PullRequestGenerationOutcome } from './create-pull-request-dialog-field-model'
import { hasConfiguredSourceControlTextGenerationDefaults } from './source-control/ai/text-generation-defaults'

type CreatePullRequest = (stacked?: boolean, fields?: PullRequestGenerationFields) => Promise<void>

/**
 * Create PR on a ready branch: when the composer still holds Orca's seeded placeholders and a PR
 * agent is configured, run the composer's own generation and create from its result, like the
 * prepare-branch path does.
 */
export function useGenerateBeforeCreatePullRequest({
  aiGenerationEnabled,
  canCreate,
  createPullRequest,
  fieldsAreSeedPlaceholders,
  generatePullRequestFields,
  generationKey,
  repo,
  settings
}: {
  aiGenerationEnabled: boolean
  canCreate: boolean
  createPullRequest: CreatePullRequest
  fieldsAreSeedPlaceholders: boolean
  generatePullRequestFields: (
    overrides: undefined,
    options: PullRequestGenerationOptions
  ) => Promise<PullRequestGenerationOutcome | void>
  generationKey: string | null
  repo: Pick<Repo, 'sourceControlAi'> | null
  settings: AppState['settings']
}) {
  const handleCreatePullRequest = useCallback(
    async (stacked = false): Promise<void> => {
      const status = generationKey
        ? useAppStore.getState().pullRequestGenerationRecords[generationKey]?.status
        : undefined
      // Why: the record is written before generation's first await, so repeated clicks see it.
      if (status === 'running') {
        return
      }
      if (
        !generationKey ||
        !canCreate ||
        !aiGenerationEnabled ||
        !fieldsAreSeedPlaceholders ||
        // Why: after a failed or stopped run the next click submits as shown, so a broken agent never blocks Create PR.
        status === 'failed' ||
        status === 'canceled' ||
        !hasConfiguredSourceControlTextGenerationDefaults({
          actionId: 'pullRequest',
          settings,
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
      // Why: the click owns the run, so create through its closure wherever the user went; a later render can show another branch or cleared eligibility.
      // The result is what the composer fills in, so the PR matches the form.
      await createPullRequest(stacked, outcome.result)
    },
    [
      aiGenerationEnabled,
      canCreate,
      createPullRequest,
      fieldsAreSeedPlaceholders,
      generatePullRequestFields,
      generationKey,
      repo,
      settings
    ]
  )

  return { handleCreatePullRequest }
}
