import { useCallback } from 'react'
import { operationGitContext } from '../listing/operation-target'
import { generateRuntimeCommitMessage } from '@/runtime/runtime-git-generation-client'
import { useAppStore } from '@/store'
import { isCustomAgentId } from '../../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'
import { hasConfiguredCommitMessageGenerationDefaults } from '../ai/text-generation-defaults'
import type { SourceControlAi } from '../ai/use-ai'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'

/** Pin generation to the run token’s worktree so navigation cannot retarget it. */
export function useSourceControlCreatePrIntentCommitMessage({
  activeRepo,
  getCreatePrIntentOperationTarget,
  operationStore,
  resolvedCommitMessageAi,
  settings
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  getCreatePrIntentOperationTarget: SourceControlCreatePrIntentTarget['getCreatePrIntentOperationTarget']
  operationStore: SourceControlWorktreeOperationState['operationStore']
  resolvedCommitMessageAi: SourceControlAi['resolvedCommitMessageAi']
  settings: SourceControlWorktreeContext['settings']
}) {
  const generateCommitMessageForCreatePrIntent = useCallback(
    async (
      token: CreatePrIntentRunToken
    ): Promise<{
      ok: boolean
      message?: string
      reason?: 'settings' | 'failed' | 'canceled'
    }> => {
      if (
        !hasConfiguredCommitMessageGenerationDefaults({ settings, repo: activeRepo ?? null }) ||
        resolvedCommitMessageAi?.ok !== true
      ) {
        return { ok: false, reason: 'settings' }
      }
      if (isCustomAgentId(resolvedCommitMessageAi.value.params.agentId)) {
        const command = resolvedCommitMessageAi.value.params.customAgentCommand?.trim() ?? ''
        if (!command) {
          return { ok: false, reason: 'settings' }
        }
      }
      const target = getCreatePrIntentOperationTarget(token)
      if (operationStore.getState().generateInFlight) {
        return { ok: false, reason: 'failed' }
      }
      operationStore.setState({ generateInFlight: true, generateError: null })
      try {
        const result = await generateRuntimeCommitMessage(
          operationGitContext(target, useAppStore.getState().settings),
          {
            sourceControlAiResolvedParams: resolvedCommitMessageAi.value.params
          }
        )
        if (!result.success) {
          if (!result.canceled) {
            operationStore.setState({ generateError: result.error })
          }
          return { ok: false, reason: result.canceled ? 'canceled' : 'failed' }
        }
        useAppStore.getState().recordFeatureInteraction('ai-commit-generation')
        operationStore.setState({ generateError: null })
        return { ok: true, message: result.message }
      } catch (error) {
        operationStore.setState({
          generateError:
            error instanceof Error ? error.message : 'Failed to generate commit message'
        })
        return { ok: false, reason: 'failed' }
      } finally {
        operationStore.setState({ generateInFlight: false })
      }
    },
    [
      activeRepo,
      getCreatePrIntentOperationTarget,
      operationStore,
      resolvedCommitMessageAi,
      settings
    ]
  )

  return { generateCommitMessageForCreatePrIntent }
}

export type SourceControlCreatePrIntentCommitMessage = ReturnType<
  typeof useSourceControlCreatePrIntentCommitMessage
>
