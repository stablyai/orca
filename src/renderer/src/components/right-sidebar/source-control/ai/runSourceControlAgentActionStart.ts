import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import {
  canLaunchSourceControlSectionAgentInPlace,
  showSourceControlAgentStartedIn
} from './section-agent-placement'
import type { DirectWorkItemLaunchResult } from '@/lib/workspace/creation/work-item/direct-work-item-setup'
import {
  sourceControlActionRecipeEntry,
  type SelectedSourceControlActionRecipe
} from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import type { AgentLaunchPreferences } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-session/launch/routing/agent-launch-request-id'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type { Repo } from '../../../../../../shared/repo-types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchChoice } from '@/lib/agent-menu-selection'
import type { LaunchSource } from '../../../../../../shared/telemetry-events'
import {
  normalizeSourceControlActionRecipe,
  type SourceControlActionRecipe,
  type SourceControlLaunchActionId
} from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { sourceControlActionRecipeSaveMatchesTarget } from './source-control-action-recipe-match'
import { resolveSourceControlAgentSaveTarget } from './source-control-agent-action-dialog-support'
import { projectSelectedSourceControlActionLaunch } from '../../../../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { admitSourceControlRecovery } from './source-control-recovery-admission'

export type RunSourceControlAgentActionStartArgs = {
  selectedAgent: TuiAgent
  trimmedCommandInput: string
  /** Deliberate surface operations remain distinct from saved route preferences. */
  launchChoice?: AgentLaunchChoice
  recipe: SelectedSourceControlActionRecipe
  saveTargetValue: string
  actionId: SourceControlLaunchActionId
  repoId?: string | null
  agentLaunchPreferences?: AgentLaunchPreferences
  repo: Pick<Repo, 'id' | 'sourceControlAi' | 'connectionId' | 'executionHostId'> | null
  worktreeId?: string | null
  groupId?: string | null
  placementWorkspaceId?: string
  initialCwd?: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  launchSource: LaunchSource
  recoveryContext?: RuntimeGitContext | null
  signal?: AbortSignal
  onCreateAccepted?: () => void
  onStart?: (args: {
    signal?: AbortSignal
    onCreateAccepted?: () => void
    onFailureNotified?: () => void
    agentLaunchPreferences?: AgentLaunchPreferences
    agent: TuiAgent
    commandInput: string
    /** Omitted when CLI arguments do not apply, so the launch resolves the global setting. */
    agentArgs?: string
    /** The action's saved choice, on either route. */
    sessionOptions?: Readonly<Record<string, string>>
    chatSessionOptions?: Readonly<Record<string, string>>
    preferredSurface?: 'chat'
    launchChoice?: AgentLaunchChoice
    sessionOptionsYieldToAgentArgs?: true
  }) => DirectWorkItemLaunchResult | Promise<DirectWorkItemLaunchResult>
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  /** Tab creation permits reversible bookkeeping; irreversible host writes belong in onLaunched after prompt delivery. */
  onLaunchAccepted?: () => void
  /** Fires when a launch that already reported onLaunchAccepted failed to deliver its prompt. */
  onLaunchAborted?: () => void
  onLaunched?: (backgroundWorkspaceId?: string) => void
  onClose: () => void
}

export async function runSourceControlAgentActionStart({
  selectedAgent,
  trimmedCommandInput,
  launchChoice,
  recipe: submittedRecipe,
  saveTargetValue,
  actionId,
  repoId,
  agentLaunchPreferences,
  repo: submittedRepo,
  worktreeId,
  groupId,
  placementWorkspaceId,
  initialCwd,
  promptDelivery,
  launchPlatform,
  launchSource,
  recoveryContext,
  signal,
  onCreateAccepted,
  onStart,
  onSaveAgentDefault,
  onLaunchAccepted,
  onLaunchAborted,
  onLaunched,
  onClose
}: RunSourceControlAgentActionStartArgs): Promise<boolean> {
  const recipe = structuredClone(submittedRecipe)
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
  const state = useAppStore.getState()
  const settings = state.settings
  const repo = submittedRepo
    ? (state.repos.find((candidate) =>
        repoMatchesHostIdentity(candidate, submittedRepo.id, getRepoExecutionHostId(submittedRepo))
      ) ?? null)
    : null
  let launched = false
  let launchFailureNotified = false
  let launchAcceptedNotified = false
  const saveTarget = resolveSourceControlAgentSaveTarget(saveTargetValue, repoId)
  // Complete only the submitted selection; later parent changes cannot rewrite this launch.
  let launchRecipe = recipe
  let recipeToSave: SourceControlActionRecipe = recipe
  if (saveTarget) {
    const saved = saveSourceControlActionRecipe({
      target: saveTarget,
      settings: settings ?? {},
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
    launchRecipe = sourceControlActionRecipeEntry(recipeToSave)
  }
  const store = useAppStore.getState()
  const inPlace =
    placementWorkspaceId &&
    worktreeId &&
    canLaunchSourceControlSectionAgentInPlace(store, worktreeId, placementWorkspaceId)
      ? placementWorkspaceId
      : undefined
  const projection = projectSelectedSourceControlActionLaunch(
    launchRecipe,
    selectedAgent,
    { renderedPrompt: trimmedCommandInput, settings },
    placementWorkspaceId ? { ...launchChoice, requestedSurface: 'terminal' } : launchChoice
  )
  const {
    commandInput: _prompt,
    agentArgs: launchAgentArgs,
    actionAgentArgs,
    requestedSurface,
    selectedExecutionHostId,
    ...launchOptions
  } = projection

  const launchRecipeAlreadySaved = Boolean(
    saveTarget &&
    sourceControlActionRecipeSaveMatchesTarget({
      actionId,
      target: saveTarget,
      recipe: launchRecipe,
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
    const result = await onStart({
      signal,
      onCreateAccepted,
      onFailureNotified: () => {
        launchFailureNotified = true
      },
      agentLaunchPreferences,
      agent: selectedAgent,
      commandInput: trimmedCommandInput,
      agentArgs: launchAgentArgs,
      ...launchOptions,
      ...(launchChoice ? { launchChoice } : {})
    })
    if (result === 'cancelled') {
      return false
    }
    launched = result
    if (launched) {
      notifyLaunchAccepted()
    }
  } else if (worktreeId) {
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      ...(placementWorkspaceId && !inPlace ? { activate: false } : {}),
      agent: selectedAgent,
      worktreeId: inPlace ?? worktreeId,
      ...(inPlace && inPlace !== worktreeId ? { trustWorktreeId: worktreeId } : {}),
      groupId:
        placementWorkspaceId && !inPlace
          ? (store.activeGroupIdByWorktree[worktreeId] ?? worktreeId)
          : ((inPlace ? store.activeGroupIdByWorktree[inPlace] : undefined) ??
            groupId ??
            placementWorkspaceId ??
            worktreeId),
      ...((!placementWorkspaceId || inPlace) && initialCwd ? { initialCwd } : {}),
      prompt: trimmedCommandInput,
      agentArgs: launchAgentArgs,
      ...launchOptions,
      requestedSurface,
      ...(actionAgentArgs !== undefined ? { actionAgentArgs } : {}),
      selectedExecutionHostId,
      promptDelivery,
      launchPlatform,
      launchSource
    })
    launched = Boolean(result)
    if (result?.surface.kind === 'local-terminal' && (!placementWorkspaceId || inPlace)) {
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

  const backgroundWorkspaceId =
    placementWorkspaceId && !inPlace && worktreeId ? worktreeId : undefined
  if (backgroundWorkspaceId) {
    showSourceControlAgentStartedIn(backgroundWorkspaceId, selectedExecutionHostId)
  }
  onLaunched?.(backgroundWorkspaceId)
  if (!signal?.aborted) {
    onClose()
  }
  return true
}
