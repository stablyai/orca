import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import type { GlobalSettings, Repo, TuiAgent } from '../../../../shared/types'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { sourceControlActionRecipeMatchesTarget } from './source-control-action-recipe-match'
import { resolveSourceControlAgentSaveTarget } from './source-control-agent-action-dialog-support'

type RunSourceControlAgentActionStartArgs = {
  selectedAgent: TuiAgent
  trimmedCommandInput: string
  agentArgs: string
  commandTemplate: string
  saveTargetValue: string
  actionId: SourceControlLaunchActionId
  repoId?: string | null
  settings: GlobalSettings | null
  repo: Pick<Repo, 'id' | 'sourceControlAi'> | null
  worktreeId?: string | null
  groupId?: string | null
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  launchSource: LaunchSource
  onStart?: (args: {
    agent: TuiAgent
    commandInput: string
    agentArgs: string
  }) => boolean | Promise<boolean>
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onLaunched?: () => void
  onClose: () => void
}

export async function runSourceControlAgentActionStart({
  selectedAgent,
  trimmedCommandInput,
  agentArgs,
  commandTemplate,
  saveTargetValue,
  actionId,
  repoId,
  settings,
  repo,
  worktreeId,
  groupId,
  promptDelivery,
  launchPlatform,
  launchSource,
  onStart,
  onSaveAgentDefault,
  onLaunched,
  onClose
}: RunSourceControlAgentActionStartArgs): Promise<boolean> {
  let launched = false
  let launchFailureNotified = false
  if (onStart) {
    launched = await onStart({
      agent: selectedAgent,
      commandInput: trimmedCommandInput,
      agentArgs
    })
  } else if (worktreeId) {
    const result = launchAgentInNewTab({
      agent: selectedAgent,
      worktreeId,
      groupId: groupId ?? worktreeId,
      prompt: trimmedCommandInput,
      agentArgs,
      promptDelivery,
      launchPlatform,
      launchSource
    })
    launched = Boolean(result)
    if (result?.tabId) {
      focusTerminalTabSurface(result.tabId)
    }
    if (result?.promptDeliveryResult) {
      try {
        const deliveryResult = await result.promptDeliveryResult
        launched = deliveryResult.delivered
        launchFailureNotified = deliveryResult.failureNotified
      } catch (error) {
        console.error('promptDeliveryResult rejected', error)
        launched = false
      }
    }
  }
  if (!launched) {
    if (!launchFailureNotified) {
      toast.error(
        translate(
          'auto.components.right.sidebar.SourceControlAgentActionDialog.8e856842d1',
          'Could not start the selected agent.'
        )
      )
    }
    return false
  }

  const saveTarget = resolveSourceControlAgentSaveTarget(saveTargetValue, repoId)
  const launchRecipe = {
    agentId: selectedAgent,
    commandInputTemplate: commandTemplate,
    agentArgs
  }
  const launchRecipeAlreadySaved = Boolean(
    saveTarget &&
    sourceControlActionRecipeMatchesTarget({
      actionId,
      target: saveTarget,
      recipe: launchRecipe,
      settings,
      repo
    })
  )
  if (saveTarget && onSaveAgentDefault && !launchRecipeAlreadySaved) {
    await onSaveAgentDefault(saveTarget, actionId, launchRecipe)
  }
  onLaunched?.()
  onClose()
  return true
}
