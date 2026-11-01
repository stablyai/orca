import type { SelectedSourceControlActionRecipe } from '../../../../shared/source-control-action-selection'
import type { AgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchChoice } from '@/lib/agent-menu-selection'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import type { RunSourceControlAgentActionStartArgs } from './runSourceControlAgentActionStart'

export type UseSourceControlAgentActionStartArgs = {
  open: boolean
  connectionId?: string | null
  selectedAgent: TuiAgent | null
  commandInput: string
  trimmedCommandInput: string
  /** False when the launch would be structured native chat, which reads no CLI arguments. */
  agentArgsApply: boolean
  prepareRecipe?: (agent: TuiAgent) => SelectedSourceControlActionRecipe
  recipe: SelectedSourceControlActionRecipe
  saveLaunchRecipe: boolean
  saveTargetValue: string
  actionId: SourceControlLaunchActionId
  repoId?: string | null
  agentLaunchPreferences: AgentLaunchPreferences
  settings: GlobalSettings | null
  repo: Pick<Repo, 'id' | 'sourceControlAi'> | null
  worktreeId?: string | null
  groupId?: string | null
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  /** SSH uses plain orca; omit the local Linux orca-ide rename in its preview. */
  isRemote?: boolean
  launchSource: LaunchSource
  recoveryContext?: RuntimeGitContext | null
  connectionUnavailable: boolean
  /** The dialog's one host observation; Start is gated on it having settled. */
  detectedAgents: TuiAgent[]
  /** The picker's choice as rendered when Start was pressed, captured before any await. */
  launchChoice?: AgentLaunchChoice
  onStart?: RunSourceControlAgentActionStartArgs['onStart']
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onLaunchAccepted?: () => void
  onLaunchAborted?: () => void
  onLaunched?: () => void
  onClose: () => void
}

export type SourceControlAgentActionStartWithDetectedAgentsArgs = {
  detectedAgents: TuiAgent[]
}

export type UseSourceControlAgentActionStartResult = {
  deliveryPlan: SourceControlAgentActionDeliveryPlanState
  resetDeliveryPlan: () => void
  cancelStart: () => void
  isStarting: boolean
  handleStart: () => Promise<void>
  startWithDetectedAgents: (
    args: SourceControlAgentActionStartWithDetectedAgentsArgs
  ) => Promise<boolean>
}
