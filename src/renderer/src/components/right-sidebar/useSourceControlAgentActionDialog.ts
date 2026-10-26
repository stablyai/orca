import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import {
  pickSourceControlLaunchAgent,
  resolveSourceControlLaunchAgentScope
} from '../../../../shared/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import type { UseSourceControlAgentActionDialogResult } from './source-control-agent-action-dialog-result'
import { sourceControlLaunchAppliesAgentArgs } from './source-control-launch-agent-args-applicability'
import { useSourceControlLaunchableAgents } from './use-source-control-launchable-agents'
import { AgentLaunchChoiceCancelled } from '@/lib/host-chat-program-acquisition'
import { useSavedSourceControlAgentActionAutoStart } from './useSavedSourceControlAgentActionAutoStart'
import {
  buildSourceControlAgentSaveTargets,
  buildSourceControlAgentScopeNote,
  buildSourceControlAgentStatusCopy,
  buildSourceControlAgentAvailability
} from './source-control-agent-action-dialog-support'
import { useSourceControlAgentActionStart } from './useSourceControlAgentActionStart'

const DEFAULT_SAVE_TARGET_VALUE = 'global'
type DiscoveryOutcome = 'pending' | 'success' | 'cancelled' | 'failed'

export function useSourceControlAgentActionDialog({
  open,
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
  const launchAgentScope = useMemo(
    () => resolveSourceControlLaunchAgentScope({ settings, repo, actionId }),
    [actionId, repo, settings]
  )
  // Update existing repo overrides in place; a new global default would remain shadowed.
  const defaultSaveTargetValue =
    launchAgentScope.overridesGlobalAgent && repoId ? 'repo' : DEFAULT_SAVE_TARGET_VALUE
  const initialRecipe = useCallback(
    (): SourceControlActionRecipe => ({
      ...resolveSourceControlActionRecipe({ settings, repo, actionId }),
      agentId: savedAgentId ?? null,
      commandInputTemplate: savedCommandInputTemplate ?? '{basePrompt}',
      agentArgs: savedAgentArgs ?? ''
    }),
    [settings, repo, actionId, savedAgentId, savedCommandInputTemplate, savedAgentArgs]
  )
  const [recipe, setRecipe] = useState(initialRecipe)
  const commandTemplate = recipe.commandInputTemplate ?? '{basePrompt}'
  const agentArgs = recipe.agentArgs ?? ''
  const openCycleRef = useRef(0)
  const wasOpenRef = useRef(false)
  const [openCycle, setOpenCycle] = useState(0)
  // The open cycle's current discovery attempt; only its success may auto-pick or auto-start.
  const [discovery, setDiscovery] = useState<{ cycle: number; outcome: DiscoveryOutcome }>()
  const saveTargets = useMemo(() => buildSourceControlAgentSaveTargets(repoId), [repoId])
  const [saveLaunchRecipe, setSaveLaunchRecipe] = useState(true)
  const [saveTargetValue, setSaveTargetValue] = useState(defaultSaveTargetValue)

  const disabledAgents = settings?.disabledTuiAgents
  const connectionUnavailable = Boolean(worktreeId && connectionId === undefined)

  const executionHostId = repo ? getRepoExecutionHostId(repo) : undefined
  const { detecting, refreshAgents, refreshLaunchableAgents, launchableAgents } =
    useSourceControlLaunchableAgents({
      target: { worktreeId, repoId, executionHostId },
      connectionId,
      connectionUnavailable,
      active: open
    })

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    const cycle = wasOpenRef.current ? openCycleRef.current : openCycleRef.current + 1
    if (!wasOpenRef.current) {
      openCycleRef.current = cycle
      setOpenCycle(cycle)
      setRecipe(initialRecipe())
      setSaveLaunchRecipe(true)
      setSaveTargetValue(defaultSaveTargetValue)
    }
    wasOpenRef.current = true
    setDiscovery({ cycle, outcome: 'pending' })
    let stale = false
    // Settle CLI-argument applicability with discovery so structured launches never flash an inapplicable field.
    void refreshAgents().then(
      () => {
        if (stale || openCycleRef.current !== cycle) {
          return
        }
        setDiscovery({ cycle, outcome: 'success' })
      },
      (error: unknown) => {
        if (!stale && openCycleRef.current === cycle) {
          const cancelled = error instanceof AgentLaunchChoiceCancelled
          setDiscovery({ cycle, outcome: cancelled ? 'cancelled' : 'failed' })
        }
      }
    )
    return () => {
      stale = true
    }
  }, [defaultSaveTargetValue, disabledAgents, open, refreshAgents, initialRecipe])

  const closeDialog = useCallback(() => onOpenChange(false), [onOpenChange])

  const selectedAgent =
    recipe.agentId && !isCustomAgentId(recipe.agentId)
      ? recipe.agentId
      : pickSourceControlLaunchAgent({
          defaultAgent: settings?.defaultTuiAgent,
          detectedAgents: launchableAgents,
          disabledAgents
        })
  const { agentOptions, selectedAgentUnavailable, hasEnabledAgents } = useMemo(
    () =>
      buildSourceControlAgentAvailability({
        detectedAgents: launchableAgents,
        disabledAgents,
        selectedAgent
      }),
    [launchableAgents, disabledAgents, selectedAgent]
  )
  const commandInput = renderSourceControlActionCommandTemplate(commandTemplate, {
    basePrompt: baseCommandInput
  })
  const trimmedCommandInput = commandInput.trim()
  // Recompute from live store/runtime capabilities each render; structured chat ignores CLI arguments and these inputs are not dependency-tracked.
  const agentArgsApply = sourceControlLaunchAppliesAgentArgs({
    agent: selectedAgent,
    worktreeId,
    repoId,
    ...(repo ? { executionHostId: getRepoExecutionHostId(repo) } : {})
  })

  const {
    deliveryPlan,
    resetDeliveryPlan,
    cancelStart,
    isStarting,
    handleStart,
    startWithDetectedAgents
  } = useSourceControlAgentActionStart({
    open,
    connectionId,
    selectedAgent,
    commandInput,
    trimmedCommandInput,
    agentArgs,
    agentArgsApply,
    recipe,
    saveLaunchRecipe,
    saveTargetValue,
    actionId,
    repoId,
    settings,
    repo,
    worktreeId,
    groupId,
    promptDelivery,
    launchPlatform,
    // SSH uses plain orca; preview must match instead of applying the local Linux orca-ide rename.
    isRemote: typeof connectionId === 'string',
    launchSource,
    recoveryContext,
    connectionUnavailable,
    refreshDetectedAgents: refreshLaunchableAgents,
    onStart,
    onSaveAgentDefault,
    onLaunchAccepted,
    onLaunchAborted,
    onLaunched,
    onClose: closeDialog
  })

  const canStart =
    Boolean(trimmedCommandInput && selectedAgent) &&
    !selectedAgentUnavailable &&
    !connectionUnavailable &&
    !detecting &&
    !isStarting

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        cancelStart()
        resetDeliveryPlan()
        setSaveLaunchRecipe(true)
        setSaveTargetValue(defaultSaveTargetValue)
      }
      onOpenChange(nextOpen)
    },
    [cancelStart, defaultSaveTargetValue, onOpenChange, resetDeliveryPlan]
  )

  const discoveryOutcome = discovery?.cycle === openCycle ? discovery.outcome : 'pending'
  const { autoLaunchPending } = useSavedSourceControlAgentActionAutoStart({
    open,
    openCycle,
    detectionReady: discoveryOutcome === 'success',
    detectionFailed: discoveryOutcome === 'cancelled' || discoveryOutcome === 'failed',
    actionId,
    baseCommandInput,
    savedAgentId,
    savedCommandInputTemplate,
    savedAgentArgs,
    settings,
    repo,
    repoId,
    worktreeId,
    connectionId,
    selectedAgent,
    trimmedCommandInput,
    connectionUnavailable,
    detecting,
    isStarting,
    detectedAgents: launchableAgents,
    disabledAgents,
    onAutoStart: ({ detectedAgents: agentsForLaunch }) =>
      startWithDetectedAgents({
        detectedAgents: agentsForLaunch,
        saveTargetValueOverride: 'none'
      })
  })

  const statusCopy = buildSourceControlAgentStatusCopy({
    selectedAgent,
    selectedAgentUnavailable,
    connectionUnavailable,
    hasEnabledAgents,
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
  const onSelectedAgentChange = resetPlanAfter((agent: TuiAgent | null) =>
    setRecipe(({ launchPreferences, ...current }) => ({
      ...current,
      agentId: agent,
      ...(launchPreferences?.agentId === agent ? { launchPreferences } : {})
    }))
  )
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
    handleOpenChange,
    shouldRenderDialog: !autoLaunchPending,
    agentScopeNote,
    agentOptions,
    selectedAgent,
    hasEnabledAgents,
    detecting,
    statusCopy,
    agentArgs,
    agentArgsApply,
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
    onSelectedAgentChange,
    onAgentArgsChange,
    onCommandTemplateChange,
    onSaveLaunchRecipeChange,
    onSaveAgentDefaultChange: setSaveTargetValue,
    handleStart
  }
}
