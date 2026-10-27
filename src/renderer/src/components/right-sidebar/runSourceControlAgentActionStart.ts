import type { AgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchChoice } from '@/lib/agent-menu-selection'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import {
  normalizeSourceControlActionRecipe,
  type SourceControlActionRecipe,
  type SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../shared/source-control-ai-recipe-save'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { sourceControlActionRecipeSaveMatchesTarget } from './source-control-action-recipe-match'
import { resolveSourceControlAgentSaveTarget } from './source-control-agent-action-dialog-support'
import { projectSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'
import { admitSourceControlRecovery } from './source-control-recovery-admission'

export type RunSourceControlAgentActionStartArgs = {
  selectedAgent: TuiAgent
  trimmedCommandInput: string
  /** The picker's choice: a deliberate surface stays explicit, a saved replay requests terminal only. */
  launchChoice?: AgentLaunchChoice
  recipe: SourceControlActionRecipe
  saveTargetValue: string
  actionId: SourceControlLaunchActionId
  repoId?: string | null
  agentLaunchPreferences?: AgentLaunchPreferences
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
    agentLaunchPreferences?: AgentLaunchPreferences
    agent: TuiAgent
    commandInput: string
    /** Omitted when CLI arguments do not apply, so the launch resolves the global setting. */
    agentArgs?: string
    /** The action's saved choice, on either route. */
    sessionOptions?: Readonly<Record<string, string>>
    launchChoice?: AgentLaunchChoice
    sessionOptionsYieldToAgentArgs?: true
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
  launchChoice,
  recipe,
  saveTargetValue,
  actionId,
  repoId,
  settings,
  agentLaunchPreferences,
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
  const saveTarget = resolveSourceControlAgentSaveTarget(saveTargetValue, repoId)
  // The dialog edits agent, arguments and prompt; the model stays the saved one for that agent.
  // Why: a recipe being saved launches as it will resolve once saved, so the next launch matches.
  let launchRecipe = recipe
  let recipeToSave = recipe
  if (saveTarget && settings) {
    const saved = saveSourceControlActionRecipe({
      target: saveTarget,
      settings,
      repo,
      actionId,
      recipe
    })
    recipeToSave =
      normalizeSourceControlActionRecipe(
        'sourceControlAi' in saved
          ? saved.sourceControlAi.actions?.[actionId]
          : saved.update.sourceControlAi?.actionOverrides?.[actionId]
      ) ?? recipe
    launchRecipe = resolveSourceControlActionRecipe({
      settings:
        'sourceControlAi' in saved
          ? { ...settings, sourceControlAi: saved.sourceControlAi }
          : settings,
      repo:
        'update' in saved ? { sourceControlAi: saved.update.sourceControlAi ?? undefined } : repo,
      actionId
    })
  }
  const projection = projectSourceControlActionLaunch(
    launchRecipe,
    selectedAgent,
    { renderedPrompt: trimmedCommandInput, settings },
    launchChoice
  )
  const {
    commandInput: _prompt,
    agentArgs: launchAgentArgs,
    requestedSurface,
    selectedExecutionHostId,
    ...launchOptions
  } = projection

  const launchRecipeAlreadySaved = Boolean(
    saveTarget &&
    sourceControlActionRecipeSaveMatchesTarget({
      actionId,
      target: saveTarget,
      recipe: recipeToSave,
      settings,
      repo
    })
  )
  if (saveTarget && onSaveAgentDefault && !launchRecipeAlreadySaved) {
    // Saving the selected recipe and delivering its prompt are independent user actions.
    void (async () => {
      try {
        await onSaveAgentDefault(saveTarget, actionId, recipeToSave)
      } catch (error) {
        console.error('onSaveAgentDefault failed', error)
        toast.error(
          translate(
            'sourceControl.actionSaveFailed',
            'Could not save this action. Try saving it again in Settings.'
          )
        )
      }
    })()
  }

  const notifyLaunchAccepted = (): void => {
    if (launchAcceptedNotified) {
      return
    }
    launchAcceptedNotified = true
    onLaunchAccepted?.()
  }
  if (onStart) {
    launched = await onStart({
      agentLaunchPreferences,
      agent: selectedAgent,
      commandInput: trimmedCommandInput,
      agentArgs: launchAgentArgs,
      ...launchOptions,
      ...(launchChoice ? { launchChoice } : {})
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
      ...launchOptions,
      requestedSurface,
      selectedExecutionHostId,
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

  onLaunched?.()
  if (!signal?.aborted) {
    onClose()
  }
  return true
}
