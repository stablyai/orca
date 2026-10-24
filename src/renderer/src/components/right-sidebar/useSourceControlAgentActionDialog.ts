import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  pickSourceControlLaunchAgent,
  resolveSourceControlLaunchAgentScope
} from '../../../../shared/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
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
  // Why: when this repo already overrides the global default, default the save
  // scope to the repo so saving the corrected agent updates that override in
  // place instead of writing a global default the override would still shadow.
  const defaultSaveTargetValue =
    launchAgentScope.overridesGlobalAgent && repoId ? 'repo' : DEFAULT_SAVE_TARGET_VALUE
  const [commandTemplate, setCommandTemplate] = useState(
    savedCommandInputTemplate ?? '{basePrompt}'
  )
  const [agentArgs, setAgentArgs] = useState(savedAgentArgs ?? '')
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(savedAgentId ?? null)
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
    }
    wasOpenRef.current = true
    setDiscovery({ cycle, outcome: 'pending' })
    setCommandTemplate(savedCommandInputTemplate ?? '{basePrompt}')
    setAgentArgs(savedAgentArgs ?? '')
    setSelectedAgent(savedAgentId ?? null)
    setSaveLaunchRecipe(true)
    setSaveTargetValue(defaultSaveTargetValue)
    let stale = false
    // Why: whether CLI arguments apply is read synchronously from the local runtime's
    // capabilities; settling them alongside detection keeps the field from appearing for a
    // frame on a launch that turns out to be structured.
    void refreshAgents().then(
      ({ detected, launchable }) => {
        if (stale || openCycleRef.current !== cycle) {
          return
        }
        setSelectedAgent(
          (current) =>
            current ??
            pickSourceControlLaunchAgent({
              savedAgent: savedAgentId,
              defaultAgent: settings?.defaultTuiAgent,
              detectedAgents: detected,
              disabledAgents,
              chosenOpensAsChat: (agent) => launchable.includes(agent)
            })
        )
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
  }, [
    defaultSaveTargetValue,
    disabledAgents,
    open,
    refreshAgents,
    savedAgentId,
    savedAgentArgs,
    savedCommandInputTemplate,
    repoId,
    settings?.defaultTuiAgent
  ])

  const closeDialog = useCallback(() => onOpenChange(false), [onOpenChange])

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
  // Why: a structured native chat session reads no CLI arguments, so the field is absent on
  // launches that would take that route and present on the terminal launches that apply them.
  // Resolved on every render rather than memoised: it reads the live store and the local
  // runtime's capabilities, neither of which is in a dependency list.
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
  const onSelectedAgentChange = useMemo(() => resetPlanAfter(setSelectedAgent), [resetPlanAfter])
  const onAgentArgsChange = useMemo(() => resetPlanAfter(setAgentArgs), [resetPlanAfter])
  const onCommandTemplateChange = useMemo(
    () => resetPlanAfter(setCommandTemplate),
    [resetPlanAfter]
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
