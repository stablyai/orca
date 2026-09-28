import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  pickSourceControlLaunchAgent,
  resolveSourceControlLaunchAgentScope
} from '@/lib/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import type { UseSourceControlAgentActionDialogResult } from './source-control-agent-action-dialog-result'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { sourceControlLaunchAppliesAgentArgs } from './source-control-launch-agent-args-applicability'
import { useSavedSourceControlAgentActionAutoStart } from './useSavedSourceControlAgentActionAutoStart'
import {
  buildSourceControlAgentSaveTargets,
  buildSourceControlAgentScopeNote,
  buildSourceControlAgentStatusCopy,
  isSourceControlAgentDetectedAndEnabled
} from './source-control-agent-action-dialog-support'
import { useSourceControlAgentActionStart } from './useSourceControlAgentActionStart'

const DEFAULT_SAVE_TARGET_VALUE = 'global'

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
  const [agentArgs, setAgentArgs] = useState(savedAgentArgs ?? '')
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(savedAgentId ?? null)
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
    setAgentArgs(savedAgentArgs ?? '')
    setSelectedAgent(savedAgentId ?? null)
    setSaveLaunchRecipe(true)
    setSaveTargetValue(defaultSaveTargetValue)
    let stale = false
    // Why: whether CLI arguments apply is read synchronously from the local runtime's
    // capabilities; settling them alongside detection keeps the field from appearing for a
    // frame on a launch that turns out to be structured.
    void Promise.all([refreshDetectedAgents(), ensureLocalRuntimeCapabilities()]).then(
      ([nextAgents]) => {
        if (stale || openCycleRef.current !== cycle) {
          return
        }
        setSelectedAgent(
          (current) =>
            current ??
            pickSourceControlLaunchAgent({
              savedAgent: savedAgentId,
              defaultAgent: settings?.defaultTuiAgent,
              detectedAgents: nextAgents,
              disabledAgents
            })
        )
        setDetectedOpenCycle(cycle)
      }
    )
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
    settings?.defaultTuiAgent
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

  const { deliveryPlan, resetDeliveryPlan, isStarting, handleStart, startWithDetectedAgents } =
    useSourceControlAgentActionStart({
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
