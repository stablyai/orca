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

export async function launchPushFailureAgentWithDefault({
  activeWorktreeId,
  activeGroupId,
  activeSourceControlLaunchPlatform,
  sourceRepoConnectionId,
  pushFailureRecoveryPrompt,
  promptOverride,
  getLaunchActionRecipe,
  getStoreState
}: {
  activeWorktreeId: string
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform
  sourceRepoConnectionId?: string | null
  pushFailureRecoveryPrompt: string | null
  promptOverride?: string
  getLaunchActionRecipe: (actionId: SourceControlLaunchActionId) => SourceControlActionRecipe
  getStoreState: () => SourceControlAiLaunchStoreSnapshot
}): Promise<boolean> {
  return launchSourceControlRecoveryAgentWithDefault({
    activeWorktreeId,
    activeGroupId,
    activeSourceControlLaunchPlatform,
    sourceRepoConnectionId,
    actionId: 'fixPushFailure',
    basePrompt: pushFailureRecoveryPrompt,
    promptOverride,
    getLaunchActionRecipe,
    getStoreState,
    copy: getDefaultSourceControlRecoveryLaunchCopy('push')
  })
}
