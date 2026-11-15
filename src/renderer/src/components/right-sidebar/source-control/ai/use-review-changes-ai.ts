import { useCallback, useState } from 'react'
import type { SelectedSourceControlActionRecipe } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import type { SourceControlLaunchActionId } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { buildReviewChangesPrompt } from '../../../../../../shared/source-control/review-changes/review-changes-prompt'
import { translate } from '@/i18n/i18n'
import { useSourceControlScope } from '../panel/worktree-scope'
import type { SourceControlAiStoreSnapshot } from './controller-types'
import {
  getDefaultSourceControlRecoveryLaunchCopy,
  launchSourceControlRecoveryAgentWithDefault
} from './recovery-launch'

type SourceControlReviewChangesAiParams = {
  activeWorktreeId: string | null | undefined
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform | undefined
  sourceRepoConnectionId?: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  getLaunchActionRecipe: (
    actionId: SourceControlLaunchActionId
  ) => SelectedSourceControlActionRecipe
  getStoreState: () => SourceControlAiStoreSnapshot
}

/** Launches the Source Control AI agent to review the workspace and leave review notes. */
export function useSourceControlReviewChangesAi({
  activeWorktreeId,
  activeGroupId,
  activeSourceControlLaunchPlatform,
  sourceRepoConnectionId,
  worktreePath,
  compareBaseRef,
  getLaunchActionRecipe,
  getStoreState
}: SourceControlReviewChangesAiParams) {
  const scope = useSourceControlScope()
  const [isLaunchingReviewChangesAgent, setIsLaunchingReviewChangesAgent] = useState(false)

  const handleReviewChangesWithAI = useCallback((): Promise<boolean> => {
    if (isLaunchingReviewChangesAgent || !activeWorktreeId || !worktreePath) {
      return Promise.resolve(false)
    }
    setIsLaunchingReviewChangesAgent(true)
    return launchSourceControlRecoveryAgentWithDefault({
      activeWorktreeId,
      placementWorkspaceId: scope?.placementWorkspaceId,
      initialCwd: scope ? worktreePath : undefined,
      executionHostId: scope?.executionHostId,
      activeGroupId,
      activeSourceControlLaunchPlatform,
      sourceRepoConnectionId,
      actionId: 'reviewChanges',
      basePrompt: buildReviewChangesPrompt({ worktreePath, baseRef: compareBaseRef }),
      getLaunchActionRecipe,
      getStoreState,
      copy: {
        ...getDefaultSourceControlRecoveryLaunchCopy('commit'),
        emptyPrompt: translate(
          'sourceControl.reviewChanges.emptyPrompt',
          'Change review prompt is empty. Update Source Control AI settings.'
        ),
        success: translate(
          'sourceControl.reviewChanges.started',
          'Started an AI agent to review the changes. Its findings will appear as notes.'
        )
      }
    }).finally(() => setIsLaunchingReviewChangesAgent(false))
  }, [
    scope,
    worktreePath,
    compareBaseRef,
    activeGroupId,
    activeWorktreeId,
    activeSourceControlLaunchPlatform,
    getLaunchActionRecipe,
    getStoreState,
    isLaunchingReviewChangesAgent,
    sourceRepoConnectionId
  ])

  return { isLaunchingReviewChangesAgent, handleReviewChangesWithAI }
}
