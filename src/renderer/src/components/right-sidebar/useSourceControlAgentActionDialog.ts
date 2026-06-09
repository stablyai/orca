import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { pickSourceControlLaunchAgent } from '@/lib/source-control-launch-agent-selection'
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/types'
import { type SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import type { UseSourceControlAgentActionDialogResult } from './source-control-agent-action-dialog-result'
import {
  buildSourceControlAgentConnectionErrorPlan,
  buildSourceControlAgentSaveTargets,
  buildSourceControlAgentStatusCopy,
  isSourceControlAgentDetectedAndEnabled
} from './source-control-agent-action-dialog-support'
import { runSourceControlAgentActionStart } from './runSourceControlAgentActionStart'

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
  const [deliveryPlan, setDeliveryPlan] = useState<SourceControlAgentActionDeliveryPlanState>({
    status: 'idle'
  })
  const [isStarting, setIsStarting] = useState(false)
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
      return
    }
    setCommandTemplate(savedCommandInputTemplate ?? '{basePrompt}')
    setAgentArgs(savedAgentArgs ?? '')
    setSelectedAgent(savedAgentId ?? null)
    setSaveLaunchRecipe(true)
    setSaveTargetValue(DEFAULT_SAVE_TARGET_VALUE)
    let stale = false
    void refreshDetectedAgents().then((nextAgents) => {
      if (stale) {
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

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setDeliveryPlan({ status: 'idle' })
        setSaveLaunchRecipe(true)
        setSaveTargetValue(DEFAULT_SAVE_TARGET_VALUE)
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

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
  const canStart =
    Boolean(trimmedCommandInput) &&
    Boolean(selectedAgent) &&
    !selectedAgentUnavailable &&
    !connectionUnavailable &&
    !detecting &&
    !isStarting

  const buildPlan = useCallback(
    async (agentsOverride?: TuiAgent[]): Promise<SourceControlAgentActionDeliveryPlanState> => {
      const currentDetectedAgents = agentsOverride ?? (await refreshDetectedAgents())
      return buildSourceControlAgentDeliveryPlan({
        selectedAgent,
        commandInput,
        agentArgs,
        promptDelivery,
        detectedAgents: currentDetectedAgents,
        connectionUnavailable,
        launchPlatform
      })
    },
    [
      agentArgs,
      commandInput,
      connectionUnavailable,
      promptDelivery,
      refreshDetectedAgents,
      selectedAgent,
      launchPlatform
    ]
  )

  const handleStart = useCallback(async () => {
    if (!selectedAgent || isStarting) {
      return
    }
    if (connectionUnavailable) {
      setDeliveryPlan(buildSourceControlAgentConnectionErrorPlan())
      return
    }
    setIsStarting(true)
    try {
      const nextAgents = await refreshDetectedAgents()
      const nextPlan = await buildPlan(nextAgents)
      if (nextPlan.status === 'error') {
        setDeliveryPlan(nextPlan)
        return
      }
      setDeliveryPlan(nextPlan)
      await runSourceControlAgentActionStart({
        selectedAgent,
        trimmedCommandInput,
        agentArgs,
        commandTemplate,
        saveTargetValue: saveLaunchRecipe ? saveTargetValue : 'none',
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
        onLaunched,
        onClose: () => handleOpenChange(false)
      })
    } finally {
      setIsStarting(false)
    }
  }, [
    actionId,
    agentArgs,
    buildPlan,
    commandTemplate,
    connectionUnavailable,
    groupId,
    isStarting,
    launchSource,
    launchPlatform,
    handleOpenChange,
    onLaunched,
    onSaveAgentDefault,
    onStart,
    promptDelivery,
    refreshDetectedAgents,
    repo,
    repoId,
    saveLaunchRecipe,
    saveTargetValue,
    settings,
    selectedAgent,
    trimmedCommandInput,
    worktreeId
  ])

  const statusCopy = buildSourceControlAgentStatusCopy({
    selectedAgent,
    selectedAgentUnavailable,
    connectionUnavailable,
    hasEnabledAgents,
    detecting
  })

  const onSelectedAgentChange = useCallback((agent: TuiAgent | null) => {
    setSelectedAgent(agent)
    setDeliveryPlan({ status: 'idle' })
  }, [])
  const onAgentArgsChange = useCallback((value: string) => {
    setAgentArgs(value)
    setDeliveryPlan({ status: 'idle' })
  }, [])
  const onCommandTemplateChange = useCallback((value: string) => {
    setCommandTemplate(value)
    setDeliveryPlan({ status: 'idle' })
  }, [])
  const onSaveLaunchRecipeChange = useCallback((value: boolean) => {
    setSaveLaunchRecipe(value)
    setDeliveryPlan({ status: 'idle' })
  }, [])

  return {
    handleOpenChange,
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
