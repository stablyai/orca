// PC-3b on the create path: an Orca Cloud create whose agent isn't set up (or whose account read is
// still loading) must not hand the host a draft startup. The host would start the agent with the
// queued prompt straight into its /login. Withheld, the create opens the workspace and the launch is
// planned in the pane, where the cloud credential gate holds it behind the "Set up once" strip; on
// Start it runs the same startup, prompt included, exactly once.
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { isOrcaCloudAccountAgent } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { cloudAgentLaunchHoldReason } from './cloud-agent-launch-hold'

export function withholdsCloudAgentBackendStartup(
  request: Pick<WorktreeCreationRequest, 'agent' | 'ephemeralVmRecipe'>
): boolean {
  const recipe = request.ephemeralVmRecipe
  if (recipe?.provider !== 'orca-cloud' && recipe?.recipeId !== ORCA_CLOUD_RECIPE_ID) {
    return false
  }
  const agent = request.agent
  if (!isOrcaCloudAccountAgent(agent)) {
    return false
  }
  // 'unknown' (first account read loading) withholds too: the pane gate waits for the read.
  return cloudAgentLaunchHoldReason(agent) !== null
}
