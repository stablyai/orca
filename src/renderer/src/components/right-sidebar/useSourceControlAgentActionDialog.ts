import { useCallback, useMemo, useState } from 'react'
import { resolveSourceControlLaunchAgentScope } from '../../../../shared/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import { savedSurfaceForPick } from '@/lib/source-control-agent-picker'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import type { UseSourceControlAgentActionDialogResult } from './source-control-agent-action-dialog-result'
import {
  buildSourceControlAgentSaveTargets,
  buildSourceControlAgentScopeNote,
  buildSourceControlAgentStatusCopy
} from './source-control-agent-action-dialog-support'
import { useSourceControlAgentActionStart } from './useSourceControlAgentActionStart'
import { useSourceControlActionAgentChoice } from './use-source-control-action-agent-choice'

const DEFAULT_SAVE_TARGET_VALUE = 'global'

export function useSourceControlAgentActionDialog({
  open,
  initialRecipe: capturedRecipe,
  onOpenChange,
  actionId,
  baseCommandInput,
  savedCommandInputTemplate,
  savedAgentArgs,
  worktreeId,
  groupId,
  connectionId,
  repoId,
  promptDelivery = 'submit-after-ready',
  launchPlatform,
  launchSource,
  recoveryContext,
  savedAgentId,
  onSaveAgentDefault,
  onLaunchAccepted,
  onLaunchAborted,
  onLaunched,
  onStart
}: SourceControlAgentActionDialogProps): UseSourceControlAgentActionDialogResult {
  const settings = useAppStore((state) => state.settings)
  const repo = useRepoById(repoId ?? null)
  const initialRecipe = useCallback((): SourceControlActionRecipe => {
    if (capturedRecipe) {
      return capturedRecipe
    }
    const { surface, ...resolved } = resolveSourceControlActionRecipe({ settings, repo, actionId })
    const agentId = savedAgentId ?? null
    return {
      ...resolved,
      // A saved chat-or-CLI pick belongs to the saved agent, like its model.
      ...(surface && resolved.agentId === agentId ? { surface } : {}),
      agentId,
      commandInputTemplate: savedCommandInputTemplate ?? '{basePrompt}',
      ...(savedAgentArgs != null ? { agentArgs: savedAgentArgs } : {})
    }
  }, [
    capturedRecipe,
    settings,
    repo,
    actionId,
    savedAgentId,
    savedCommandInputTemplate,
    savedAgentArgs
  ])
  const [recipe, setRecipe] = useState(initialRecipe)
  const [livePick, setLivePick] = useState<AgentLaunchSurface | undefined>(undefined)
  const commandTemplate = recipe.commandInputTemplate ?? '{basePrompt}'
  const agentArgs = recipe.agentArgs ?? ''
  const saveTargets = useMemo(() => buildSourceControlAgentSaveTargets(repoId), [repoId])
  const [saveLaunchRecipe, setSaveLaunchRecipe] = useState(true)
  const [explicitSaveTarget, setSaveTargetValue] = useState<string>()
  const connectionUnavailable = Boolean(worktreeId && connectionId === undefined)

  const closeDialog = useCallback(() => onOpenChange(false), [onOpenChange])

  const choice = useSourceControlActionAgentChoice({
    open,
    worktreeId,
    repoId,
    repo,
    recipe,
    livePick,
    settings
  })
  const launchAgentScope = useMemo(
    () =>
      resolveSourceControlLaunchAgentScope({
        settings: { ...settings, ...choice.observation.preferences },
        repo,
        actionId
      }),
    [actionId, repo, settings, choice.observation.preferences]
  )
  // Update existing repo overrides in place; a new global default would remain shadowed.
  const defaultSaveTargetValue =
    launchAgentScope.overridesGlobalAgent && repoId ? 'repo' : DEFAULT_SAVE_TARGET_VALUE
  const saveTargetValue = explicitSaveTarget ?? defaultSaveTargetValue
  const { selectedAgent, detectedAgents, detecting, selection } = choice
  const commandInput = renderSourceControlActionCommandTemplate(commandTemplate, {
    basePrompt: baseCommandInput
  })
  const trimmedCommandInput = commandInput.trim()
  const { deliveryPlan, resetDeliveryPlan, cancelStart, isStarting, handleStart } =
    useSourceControlAgentActionStart({
      open,
      connectionId,
      selectedAgent,
      commandInput,
      trimmedCommandInput,
      agentArgs: recipe.agentArgs,
      agentArgsApply: choice.launchAppliesAgentArgs,
      recipe: choice.canSaveSurface ? recipe : (({ surface: _surface, ...rest }) => rest)(recipe),
      saveLaunchRecipe,
      saveTargetValue,
      actionId,
      repoId,
      settings,
      agentLaunchPreferences: choice.observation.preferences,
      repo,
      worktreeId,
      groupId,
      promptDelivery,
      launchPlatform,
      // Why: an SSH host runs the plain `orca` shim; keep the previewed command
      // label aligned with the real remote launch (no `orca-ide` rename).
      isRemote: typeof connectionId === 'string',
      launchSource,
      recoveryContext,
      connectionUnavailable,
      detectedAgents,
      launchChoice: selection.choice,
      onStart,
      onSaveAgentDefault,
      onLaunchAccepted,
      onLaunchAborted,
      onLaunched,
      onClose: closeDialog
    })

  const canStart =
    Boolean(trimmedCommandInput) &&
    Boolean(selectedAgent) &&
    !choice.selectedAgentUnavailable &&
    !connectionUnavailable &&
    !detecting &&
    selection.ready &&
    !isStarting

  const statusCopy = buildSourceControlAgentStatusCopy({
    selectedAgent,
    selectedAgentUnavailable: choice.selectedAgentUnavailable,
    connectionUnavailable,
    hasEnabledAgents: choice.hasEnabledAgents,
    detecting
  })

  // Why: editing any launch field invalidates the previewed delivery plan.
  const resetPlanAfter = useCallback(
    <T>(apply: (value: T) => void) =>
      (value: T): void => {
        apply(value)
        resetDeliveryPlan()
      },
    [resetDeliveryPlan]
  )
  // A pick changes route even for the same agent, so it always invalidates the previewed plan.
  const onAgentPick = (agent: TuiAgent, surface?: AgentLaunchSurface): void => {
    const saved = savedSurfaceForPick(choice.observation.model, agent, surface)
    setLivePick(surface)
    setRecipe(({ launchPreferences, surface: _previous, ...current }) => ({
      ...current,
      agentId: agent,
      ...(launchPreferences?.agentId === agent ? { launchPreferences } : {}),
      ...(saved ? { surface: saved } : {})
    }))
    resetDeliveryPlan()
  }
  const onAgentArgsChange = resetPlanAfter((agentArgs: string) =>
    setRecipe((current) => ({ ...current, agentArgs }))
  )
  const onCommandTemplateChange = resetPlanAfter((commandInputTemplate: string) =>
    setRecipe((current) => ({ ...current, commandInputTemplate }))
  )
  const onSaveLaunchRecipeChange = useMemo(
    () => resetPlanAfter(setSaveLaunchRecipe),
    [resetPlanAfter]
  )

  const agentScopeNote = useMemo(
    () => buildSourceControlAgentScopeNote(launchAgentScope),
    [launchAgentScope]
  )

  return {
    handleOpenChange: (nextOpen) => {
      if (!nextOpen) {
        cancelStart()
      }
      onOpenChange(nextOpen)
    },
    agentScopeNote,
    agentOptions: choice.agentOptions,
    selectedAgent,
    hasEnabledAgents: choice.hasEnabledAgents,
    detecting,
    surfaceRows: {
      model: choice.observation.model,
      selection: choice.pickerSelection,
      contextKey: choice.observation.contextKey,
      surface: choice.liveSurface,
      onPick: onAgentPick
    },
    statusCopy,
    agentArgs,
    agentArgsApply: choice.launchAppliesAgentArgs,
    commandTemplate,
    recipe,
    saveLaunchRecipe,
    saveTargetValue,
    saveTargets,
    settings,
    repo,
    deliveryPlan,
    canStart,
    isStarting,
    onAgentPick,
    onAgentArgsChange,
    onCommandTemplateChange,
    onSaveLaunchRecipeChange,
    onSaveAgentDefaultChange: setSaveTargetValue,
    handleStart
  }
}
