import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
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
import {
  normalizeRepoSourceControlAiOverrides,
  resolveSourceControlActionRecipe
} from '../../../../shared/source-control-ai'
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
  /**
   * Fires as soon as the agent tab/session is created, before deferred
   * submit-after-ready prompt delivery finishes. Reversible bookkeeping only —
   * irreversible side effects (posting host replies, resolving threads) belong in
   * onLaunched, which only fires once the prompt actually reached the agent.
   */
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
  onLaunchAccepted,
  onLaunchAborted,
  onLaunched,
  onClose
}: RunSourceControlAgentActionStartArgs): Promise<boolean> {
  // Why: both launch paths resolve the recipe host-side from the owner locator
  // (the client no longer sends assembled args), so "Save & start" must persist
  // the recipe first or the launch runs against the previous stored snapshot.
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
  // Why: the host resolves agentArgs from the owner locator, so the launch needs
  // the edited args sent alongside it unless the EFFECTIVE recipe (repo override
  // shadowing global) already carries them.
  let launchArgsPersisted =
    (resolveSourceControlActionRecipe({ settings, repo, actionId }).agentArgs?.trim() ?? '') ===
    agentArgs.trim()
  // Why: a repo-level agentArgs override shadows the global recipe per field, so
  // a global save never becomes what the host resolves for this repo.
  const repoOverridesActionArgs =
    normalizeRepoSourceControlAiOverrides(repo?.sourceControlAi)?.actionOverrides?.[actionId]
      ?.agentArgs !== undefined
  if (saveTarget && onSaveAgentDefault && !launchRecipeAlreadySaved) {
    try {
      await onSaveAgentDefault(saveTarget, actionId, launchRecipe)
      launchArgsPersisted =
        launchArgsPersisted || saveTarget.type === 'repo' || !repoOverridesActionArgs
    } catch (error) {
      console.error('saving the agent recipe before launch failed', error)
      toast.error(
        translate(
          'auto.components.right.sidebar.SourceControlAgentActionDialog.saveBeforeStartFailed',
          'Could not save the agent settings, so the agent was not started.'
        )
      )
      return false
    }
  }

  let launched = false
  let launchFailureNotified = false
  let launchAcceptedNotified = false
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
      agentArgs
    })
    if (launched) {
      notifyLaunchAccepted()
    }
  } else if (worktreeId) {
    const result = launchAgentInNewTab({
      agent: selectedAgent,
      worktreeId,
      groupId: groupId ?? worktreeId,
      prompt: trimmedCommandInput,
      sourceRecord: { owner: 'source-control-recipe' as const, id: actionId },
      // Why: the host resolves the recipe's stored agentArgs from the locator, so
      // a "Don't save" launch must send the edited args for the host to use in
      // their place — otherwise it runs the stale persisted snapshot. Best-effort:
      // a host predating the field still launches the stored args.
      ...(launchArgsPersisted ? {} : { unsavedAgentArgs: agentArgs.trim() }),
      promptDelivery,
      launchPlatform,
      launchSource
    })
    launched = true
    if (result.tabId) {
      focusTerminalTabSurface(result.tabId)
    }
    // Why: lets callers park launch-scoped state before submit-after-ready finishes
    // (can take tens of seconds); host mutations still wait for delivery below.
    if (launched) {
      notifyLaunchAccepted()
    }
    if (result.promptDeliveryResult) {
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
  onClose()
  return true
}
