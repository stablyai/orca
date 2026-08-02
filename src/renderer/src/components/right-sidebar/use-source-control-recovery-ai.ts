import { useCallback, useMemo, useState } from 'react'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { GitStatusEntry } from '../../../../shared/types'
import { buildFixCommitFailurePrompt } from './source-control-ai-prompts'
import { summarizeCommitFailure } from './commit-failure-summary'
import {
  getDefaultSourceControlRecoveryLaunchCopy,
  launchSourceControlRecoveryAgentWithDefault
} from './source-control-ai-recovery-launch'
import type { SourceControlAiStoreSnapshot } from './source-control-ai-controller-types'

type SourceControlRecoveryAiParams = {
  activeWorktreeId: string | null | undefined
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform
  sourceRepoConnectionId?: string | null
  worktreePath: string | null
  commitMessage: string
  commitError: string | null
  pushRecoveryPrompt: string | null
  stagedEntries: Pick<GitStatusEntry, 'path' | 'status' | 'area'>[]
  getLaunchActionRecipe: (actionId: SourceControlLaunchActionId) => SourceControlActionRecipe
  getStoreState: () => SourceControlAiStoreSnapshot
}

export function useSourceControlRecoveryAi({
  activeWorktreeId,
  activeGroupId,
  activeSourceControlLaunchPlatform,
  sourceRepoConnectionId,
  worktreePath,
  commitMessage,
  commitError,
  pushRecoveryPrompt,
  stagedEntries,
  getLaunchActionRecipe,
  getStoreState
}: SourceControlRecoveryAiParams) {
  const [isLaunchingCommitFailureAgent, setIsLaunchingCommitFailureAgent] = useState(false)
  const [isLaunchingPushFailureAgent, setIsLaunchingPushFailureAgent] = useState(false)

  const commitFailureRecoveryPrompt = useMemo(
    () =>
      commitError
        ? buildFixCommitFailurePrompt({
            summary: summarizeCommitFailure(commitError),
            error: commitError,
            entries: stagedEntries,
            worktreePath,
            commitMessage
          })
        : null,
    [commitError, commitMessage, stagedEntries, worktreePath]
  )
  const handleFixCommitFailureWithAI = useCallback(
    async (promptOverride?: string): Promise<boolean> => {
      if (isLaunchingCommitFailureAgent || !activeWorktreeId || !commitError) {
        return false
      }

      setIsLaunchingCommitFailureAgent(true)
      try {
        return await launchSourceControlRecoveryAgentWithDefault({
          activeWorktreeId,
          activeGroupId,
          activeSourceControlLaunchPlatform,
          sourceRepoConnectionId,
          actionId: 'fixCommitFailure',
          basePrompt: commitFailureRecoveryPrompt,
          promptOverride,
          getLaunchActionRecipe,
          getStoreState,
          copy: getDefaultSourceControlRecoveryLaunchCopy('commit')
        })
      } finally {
        setIsLaunchingCommitFailureAgent(false)
      }
    },
    [
      activeGroupId,
      activeWorktreeId,
      activeSourceControlLaunchPlatform,
      commitError,
      commitFailureRecoveryPrompt,
      getLaunchActionRecipe,
      getStoreState,
      isLaunchingCommitFailureAgent,
      sourceRepoConnectionId
    ]
  )

  const handleFixPushFailureWithAI = useCallback(
    async (promptOverride?: string): Promise<boolean> => {
      if (isLaunchingPushFailureAgent || !activeWorktreeId || !pushRecoveryPrompt) {
        return false
      }

      setIsLaunchingPushFailureAgent(true)
      try {
        return await launchSourceControlRecoveryAgentWithDefault({
          activeWorktreeId,
          activeGroupId,
          activeSourceControlLaunchPlatform,
          sourceRepoConnectionId,
          actionId: 'fixPushFailure',
          basePrompt: pushRecoveryPrompt,
          promptOverride,
          getLaunchActionRecipe,
          getStoreState,
          copy: getDefaultSourceControlRecoveryLaunchCopy('push')
        })
      } finally {
        setIsLaunchingPushFailureAgent(false)
      }
    },
    [
      activeGroupId,
      activeWorktreeId,
      activeSourceControlLaunchPlatform,
      getLaunchActionRecipe,
      getStoreState,
      isLaunchingPushFailureAgent,
      pushRecoveryPrompt,
      sourceRepoConnectionId
    ]
  )

  return {
    isLaunchingCommitFailureAgent,
    isLaunchingPushFailureAgent,
    commitFailureRecoveryPrompt,
    pushFailureRecoveryPrompt: pushRecoveryPrompt,
    handleFixCommitFailureWithAI,
    handleFixPushFailureWithAI
  }
}
