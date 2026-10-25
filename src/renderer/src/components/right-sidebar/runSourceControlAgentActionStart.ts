import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
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
import { admitSourceControlRecovery } from './source-control-recovery-admission'

type RunSourceControlAgentActionStartArgs = {
  selectedAgent: TuiAgent
  trimmedCommandInput: string
  agentArgs: string
  /** False when the launch would be structured native chat, which reads no CLI arguments. */
  agentArgsApply: boolean
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
  recoveryContext?: RuntimeGitContext | null
  signal?: AbortSignal
  onStart?: (args: {
    agent: TuiAgent
    commandInput: string
    /** Omitted when CLI arguments do not apply, so the launch resolves the global setting. */
    agentArgs?: string
  }) => boolean | Promise<boolean>
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  /** Tab creation permits reversible bookkeeping; irreversible host writes belong in onLaunched after prompt delivery. */
  onLaunchAccepted?: () => void
  /** Fires when a launch that already reported onLaunchAccepted failed to deliver its prompt. */
  onLaunchAborted?: () => void
  onLaunched?: () => void
  onClose: () => void
}

export async function runSourceControlAgentActionStart({
  selectedAgent,
  trimmedCommandInput,
  agentArgs,
  agentArgsApply,
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
  recoveryContext,
  signal,
  onStart,
  onSaveAgentDefault,
  onLaunchAccepted,
  onLaunchAborted,
  onLaunched,
  onClose
}: RunSourceControlAgentActionStartArgs): Promise<boolean> {
  // Detection and delivery planning can outlive the state that opened the composer.
  if (signal?.aborted) {
    return false
  }
  if (recoveryContext && !(await admitSourceControlRecovery(recoveryContext, signal))) {
    return false
  }
  if (signal?.aborted) {
    return false
  }
  let launched = false
  let launchFailureNotified = false
  let launchAcceptedNotified = false
  // Undefined selects global agent arguments; empty string would suppress that fallback.
  const launchAgentArgs = agentArgsApply ? agentArgs : undefined
  const notifyLaunchAccepted = (): void => {
    if (launchAcceptedNotified) {
      return
    }
    launchAcceptedNotified = true
    onLaunchAccepted?.()
  }
  if (onStart) {
    launched = await onStart({
      agent: selectedAgent,
      commandInput: trimmedCommandInput,
      agentArgs: launchAgentArgs
    })
    if (launched) {
      notifyLaunchAccepted()
    }
  } else if (worktreeId) {
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: selectedAgent,
      worktreeId,
      groupId: groupId ?? worktreeId,
      prompt: trimmedCommandInput,
      agentArgs: launchAgentArgs,
      promptDelivery,
      launchPlatform,
      launchSource
    })
    launched = Boolean(result)
    if (result?.surface.kind === 'local-terminal') {
      focusTerminalTabSurface(result.surface.tabId)
    }
    // Park launch state before slow submit-after-ready completes; host writes still wait for delivery.
    if (launched) {
      notifyLaunchAccepted()
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
    if (launchAcceptedNotified) {
      onLaunchAborted?.()
    }
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
    try {
      await onSaveAgentDefault(saveTarget, actionId, launchRecipe)
    } catch (error) {
      // Prompt delivery succeeded; recipe-save failure must not prevent accepted-launch callbacks from settling.
      console.error('onSaveAgentDefault failed', error)
    }
  }
  onLaunched?.()
  if (!signal?.aborted) {
    onClose()
  }
  return true
}
