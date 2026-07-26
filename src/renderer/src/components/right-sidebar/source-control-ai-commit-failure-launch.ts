import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import {
  getDefaultSourceControlRecoveryLaunchCopy,
  launchSourceControlRecoveryAgentWithDefault
} from './source-control-ai-recovery-launch'
import type { AppState } from '@/store'

type SourceControlAiLaunchStoreSnapshot = Pick<
  AppState,
  'settings' | 'ensureDetectedAgents' | 'ensureRemoteDetectedAgents'
>

export async function launchCommitFailureAgentWithDefault({
  activeWorktreeId,
  activeGroupId,
  activeSourceControlLaunchPlatform,
  sourceRepoConnectionId,
  commitFailureRecoveryPrompt,
  promptOverride,
  getLaunchActionRecipe,
  getStoreState
}: {
  activeWorktreeId: string
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform
  sourceRepoConnectionId?: string | null
  commitFailureRecoveryPrompt: string | null
  promptOverride?: string
  getLaunchActionRecipe: (actionId: SourceControlLaunchActionId) => SourceControlActionRecipe
  getStoreState: () => SourceControlAiLaunchStoreSnapshot
}): Promise<boolean> {
  return launchSourceControlRecoveryAgentWithDefault({
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
}
