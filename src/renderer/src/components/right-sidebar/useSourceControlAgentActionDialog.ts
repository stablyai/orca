import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  pickSourceControlLaunchAgent,
  resolveSourceControlLaunchAgentScope
} from '@/lib/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveTuiAgentLaunchArgs } from '../../../../shared/tui-agent-launch-defaults'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import type { UseSourceControlAgentActionDialogResult } from './source-control-agent-action-dialog-result'
import { useSavedSourceControlAgentActionAutoStart } from './useSavedSourceControlAgentActionAutoStart'
import {
  buildSourceControlAgentSaveTargets,
  buildSourceControlAgentStatusCopy,
  isSourceControlAgentDetectedAndEnabled
} from './source-control-agent-action-dialog-support'
import { useSourceControlAgentActionStart } from './useSourceControlAgentActionStart'

const DEFAULT_SAVE_TARGET_VALUE = 'global'

/**
 * Custom hook that manages the state and launch arguments for the Source Control Agent Action Dialog.
 * It resolves initial and fallback agents, handles custom agent launch arguments (defaulting to YOLO mode
 * for Gemini when no custom arguments are set), and coordinates starting the agent action.
 *
 * @param props - Configuration properties for the dialog.
 * @returns The structured dialog state and event handlers.
 */
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
  // Why: when this repo already overrides the global default, default the save
  // scope to the repo so saving the corrected agent updates that override in
  // place instead of writing a global default the override would still shadow.
  const defaultSaveTargetValue =
    launchAgentScope.overridesGlobalAgent && repoId ? 'repo' : DEFAULT_SAVE_TARGET_VALUE
  const ensureDetectedAgents = useAppStore((state) => state.ensureDetectedAgents)
  const ensureRemoteDetectedAgents = useAppStore((state) => state.ensureRemoteDetectedAgents)
  const [commandTemplate, setCommandTemplate] = useState(
    savedCommandInputTemplate ?? '{basePrompt}'
  )
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(savedAgentId ?? null)
  const [agentArgs, setAgentArgs] = useState(
    savedAgentArgs ??
      (savedAgentId ? resolveTuiAgentLaunchArgs(savedAgentId, settings?.agentDefaultArgs) : '')
  )
  const [detectedAgents, setDetectedAgents] = useState<TuiAgent[]>([])
  const [detecting, setDetecting] = useState(false)
  const openCycleRef = useRef(0)
  const wasOpenRef = useRef(false)
  const [openCycle, setOpenCycle] = useState(0)
  const [detectedOpenCycle, setDetectedOpenCycle] = useState<number | null>(null)
  const saveTargets = useMemo(() => buildSourceControlAgentSaveTargets(repoId), [repoId])
  const [saveLaunchRecipe, setSaveLaunchRecipe] = useState(true)
  const [saveTargetValue, setSaveTargetValue] = useState(defaultSaveTargetValue)

  const disabledAgents = settings?.disabledTuiAgents
  const connectionUnavailable = Boolean(worktreeId && connectionId === undefined)

  const refreshDetectedAgents = useCallback(async (): Promise<TuiAgent[]> => {
    if (connectionUnavailable) {
      setDetectedAgents([])
      setDetecting(false)
      return []
    }
    setDetecting(true)
    try {
      const nextAgents =
        typeof connectionId === 'string'
          ? await ensureRemoteDetectedAgents(connectionId)
          : await ensureDetectedAgents()
      setDetectedAgents(nextAgents)
      return nextAgents
    } finally {
      setDetecting(false)
    }
  }, [connectionId, connectionUnavailable, ensureDetectedAgents, ensureRemoteDetectedAgents])

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    const cycle = wasOpenRef.current ? openCycleRef.current : openCycleRef.current + 1
    if (!wasOpenRef.current) {
      openCycleRef.current = cycle
      setOpenCycle(cycle)
    }
    wasOpenRef.current = true
    setDetectedOpenCycle(null)
    setCommandTemplate(savedCommandInputTemplate ?? '{basePrompt}')
    setSelectedAgent(savedAgentId ?? null)
    setAgentArgs(
      savedAgentArgs ??
        (savedAgentId ? resolveTuiAgentLaunchArgs(savedAgentId, settings?.agentDefaultArgs) : '')
    )
    setSaveLaunchRecipe(true)
    setSaveTargetValue(defaultSaveTargetValue)
    let stale = false
    void refreshDetectedAgents().then((nextAgents) => {
      if (stale || openCycleRef.current !== cycle) {
        return
      }
      const fallbackAgent = pickSourceControlLaunchAgent({
        savedAgent: savedAgentId,
        defaultAgent: settings?.defaultTuiAgent,
        detectedAgents: nextAgents,
        disabledAgents
      })
      const finalAgent = fallbackAgent
      setSelectedAgent(finalAgent)
      if (savedAgentArgs === null || savedAgentArgs === undefined) {
        setAgentArgs(
          finalAgent ? resolveTuiAgentLaunchArgs(finalAgent, settings?.agentDefaultArgs) : ''
        )
      }
      setDetectedOpenCycle(cycle)
    })
    return () => {
      stale = true
    }
  }, [
    defaultSaveTargetValue,
    disabledAgents,
    open,
    refreshDetectedAgents,
    savedAgentId,
    savedAgentArgs,
    savedCommandInputTemplate,
    repoId,
    settings?.defaultTuiAgent,
    settings?.agentDefaultArgs
  ])

  const closeDialog = useCallback(() => onOpenChange(false), [onOpenChange])

  const enabledDetectedAgents = useMemo(
    () => detectedAgents.filter((agent) => isTuiAgentEnabled(agent, disabledAgents)),
    [detectedAgents, disabledAgents]
  )
  const agentOptions = useMemo(
    () =>
      getAgentCatalog().filter(
        (entry) => enabledDetectedAgents.includes(entry.id) || entry.id === selectedAgent
      ),
    [enabledDetectedAgents, selectedAgent]
  )
  const selectedAgentUnavailable = Boolean(
    selectedAgent &&
    !isSourceControlAgentDetectedAndEnabled(selectedAgent, detectedAgents, disabledAgents)
  )
  const hasEnabledAgents = enabledDetectedAgents.length > 0
  const commandInput = renderSourceControlActionCommandTemplate(commandTemplate, {
    basePrompt: baseCommandInput
  })
  const trimmedCommandInput = commandInput.trim()

  const { deliveryPlan, resetDeliveryPlan, isStarting, handleStart, startWithDetectedAgents } =
    useSourceControlAgentActionStart({
      selectedAgent,
      commandInput,
      trimmedCommandInput,
      agentArgs,
      commandTemplate,
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
      // Why: an SSH host runs the plain `orca` shim; keep the previewed command
      // label aligned with the real remote launch (no `orca-ide` rename).
      isRemote: typeof connectionId === 'string',
      launchSource,
      connectionUnavailable,
      refreshDetectedAgents,
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
    !selectedAgentUnavailable &&
    !connectionUnavailable &&
    !detecting &&
    !isStarting

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetDeliveryPlan()
        setSaveLaunchRecipe(true)
        setSaveTargetValue(defaultSaveTargetValue)
      }
      onOpenChange(nextOpen)
    },
    [defaultSaveTargetValue, onOpenChange, resetDeliveryPlan]
  )

  const { autoLaunchPending } = useSavedSourceControlAgentActionAutoStart({
    open,
    openCycle,
    detectionReady: detectedOpenCycle === openCycle,
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
    detectedAgents,
    disabledAgents,
    onAutoStart: ({ detectedAgents: agentsForLaunch, saveTargetValue: matchedTargetValue }) =>
      startWithDetectedAgents({
        detectedAgents: agentsForLaunch,
        saveTargetValueOverride: matchedTargetValue
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
  /**
   * Updates the selected agent and resolves the appropriate launch arguments.
   * If saved arguments are not present, resolves the per-agent defaults from the saved settings.
   *
   * @param nextAgent - The newly selected TUI agent, or null if no agent is selected.
   */
  const handleSelectedAgentChange = useCallback(
    (nextAgent: TuiAgent | null) => {
      setSelectedAgent(nextAgent)
      if (savedAgentArgs === null || savedAgentArgs === undefined) {
        if (nextAgent) {
          setAgentArgs(resolveTuiAgentLaunchArgs(nextAgent, settings?.agentDefaultArgs))
        } else {
          setAgentArgs('')
        }
      }
    },
    [savedAgentArgs, settings?.agentDefaultArgs]
  )
  const onSelectedAgentChange = useMemo(
    () => resetPlanAfter(handleSelectedAgentChange),
    [resetPlanAfter, handleSelectedAgentChange]
  )
  const onAgentArgsChange = useMemo(() => resetPlanAfter(setAgentArgs), [resetPlanAfter])
  const onCommandTemplateChange = useMemo(
    () => resetPlanAfter(setCommandTemplate),
    [resetPlanAfter]
  )
  const onSaveLaunchRecipeChange = useMemo(
    () => resetPlanAfter(setSaveLaunchRecipe),
    [resetPlanAfter]
  )

  const agentScopeNote = useMemo(() => {
    if (!launchAgentScope.overridesGlobalAgent) {
      return null
    }
    const catalog = getAgentCatalog()
    const labelFor = (agentId: TuiAgent | null): string =>
      catalog.find((entry) => entry.id === agentId)?.label ?? agentId ?? ''
    return {
      effectiveAgentLabel: labelFor(launchAgentScope.effectiveAgentId),
      globalAgentLabel: labelFor(launchAgentScope.globalAgentId)
    }
  }, [launchAgentScope])

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
    commandTemplate,
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
