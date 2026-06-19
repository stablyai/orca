import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { pickSourceControlLaunchAgent } from '@/lib/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/types'
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
  onLaunched,
  onStart
}: SourceControlAgentActionDialogProps): UseSourceControlAgentActionDialogResult {
  const settings = useAppStore((state) => state.settings)
  const repo = useRepoById(repoId ?? null)
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
  const [saveTargetValue, setSaveTargetValue] = useState(DEFAULT_SAVE_TARGET_VALUE)

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
    setSaveTargetValue(DEFAULT_SAVE_TARGET_VALUE)
    let stale = false
    void refreshDetectedAgents().then((nextAgents) => {
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
    })
    return () => {
      stale = true
    }
  }, [
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
      launchSource,
      connectionUnavailable,
      refreshDetectedAgents,
      onStart,
      onSaveAgentDefault,
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
        setSaveTargetValue(DEFAULT_SAVE_TARGET_VALUE)
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, resetDeliveryPlan]
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

  const onSelectedAgentChange = useCallback(
    (agent: TuiAgent | null) => {
      setSelectedAgent(agent)
      resetDeliveryPlan()
    },
    [resetDeliveryPlan]
  )
  const onAgentArgsChange = useCallback(
    (value: string) => {
      setAgentArgs(value)
      resetDeliveryPlan()
    },
    [resetDeliveryPlan]
  )
  const onCommandTemplateChange = useCallback(
    (value: string) => {
      setCommandTemplate(value)
      resetDeliveryPlan()
    },
    [resetDeliveryPlan]
  )
  const onSaveLaunchRecipeChange = useCallback(
    (value: boolean) => {
      setSaveLaunchRecipe(value)
      resetDeliveryPlan()
    },
    [resetDeliveryPlan]
  )

  return {
    handleOpenChange,
    shouldRenderDialog: !autoLaunchPending,
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
