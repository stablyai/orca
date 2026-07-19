import { useCallback, useMemo, useState } from 'react'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { resolveSourceControlLaunchAgentScope } from '@/lib/source-control-launch-agent-selection'
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
  buildSourceControlAgentScopeNote,
  buildSourceControlAgentStatusCopy,
  isSourceControlAgentDetectedAndEnabled
} from './source-control-agent-action-dialog-support'
import { useSourceControlAgentActionDialogOpenSync } from './useSourceControlAgentActionDialogOpenSync'
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
  preferredAgentId,
  disableSavedRecipeAutoStart = false,
  onSaveAgentDefault,
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
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(
    preferredAgentId ?? savedAgentId ?? null
  )
  const [detectedAgents, setDetectedAgents] = useState<TuiAgent[]>([])
  const [detecting, setDetecting] = useState(false)
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

  const { openCycle, detectedOpenCycle } = useSourceControlAgentActionDialogOpenSync({
    open,
    preferredAgentId,
    savedAgentId,
    savedAgentArgs,
    savedCommandInputTemplate,
    defaultSaveTargetValue,
    disabledAgents,
    settings,
    refreshDetectedAgents,
    setCommandTemplate,
    setAgentArgs,
    setSelectedAgent,
    setSaveLaunchRecipe,
    setSaveTargetValue
  })

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
    disableSavedRecipeAutoStart,
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
