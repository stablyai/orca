import { useCallback } from 'react'
import { generateRuntimeCommitMessage } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import { isCustomAgentId } from '../../../../../../shared/commit-message-agent-spec'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'
import { hasConfiguredCommitMessageGenerationDefaults } from '../ai/text-generation-defaults'
import type { SourceControlAi } from '../ai/use-ai'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'

/**
 * Generates the commit message the Create-PR intent needs, keyed to the run token's worktree rather
 * than the focused one so a mid-run worktree switch can't retarget the generation.
 */
export function useSourceControlCreatePrIntentCommitMessage({
  activeRepo,
  generateInFlightRef,
  getCreatePrIntentOperationTarget,
  resolvedCommitMessageAi,
  setGenerateErrors,
  setGenerateInFlightByWorktree,
  settings
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  generateInFlightRef: SourceControlWorktreeOperationState['generateInFlightRef']
  getCreatePrIntentOperationTarget: SourceControlCreatePrIntentTarget['getCreatePrIntentOperationTarget']
  resolvedCommitMessageAi: SourceControlAi['resolvedCommitMessageAi']
  setGenerateErrors: SourceControlWorktreeOperationState['setGenerateErrors']
  setGenerateInFlightByWorktree: SourceControlWorktreeOperationState['setGenerateInFlightByWorktree']
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
      if (generateInFlightRef.current[target.worktreeId]) {
        return { ok: false, reason: 'failed' }
      }

      generateInFlightRef.current[target.worktreeId] = true
      setGenerateInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: true }))
      setGenerateErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
      try {
        const result = await generateRuntimeCommitMessage(target, {
          sourceControlAiResolvedParams: resolvedCommitMessageAi.value.params
        })
        if (!result.success) {
          if (!result.canceled) {
            setGenerateErrors((prev) => ({ ...prev, [target.worktreeId]: result.error }))
          }
          return { ok: false, reason: result.canceled ? 'canceled' : 'failed' }
        }
        useAppStore.getState().recordFeatureInteraction('ai-commit-generation')
        setGenerateErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
        return { ok: true, message: result.message }
      } catch (error) {
        setGenerateErrors((prev) => ({
          ...prev,
          [target.worktreeId]:
            error instanceof Error ? error.message : 'Failed to generate commit message'
        }))
        return { ok: false, reason: 'failed' }
      } finally {
        setGenerateInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: false }))
        generateInFlightRef.current[target.worktreeId] = false
      }
    },
    [
      activeRepo,
      generateInFlightRef,
      getCreatePrIntentOperationTarget,
      resolvedCommitMessageAi,
      setGenerateErrors,
      setGenerateInFlightByWorktree,
      settings
    ]
  )

  return { generateCommitMessageForCreatePrIntent }
}

export type SourceControlCreatePrIntentCommitMessage = ReturnType<
  typeof useSourceControlCreatePrIntentCommitMessage
>
