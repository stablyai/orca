import { useCallback, useRef, useState } from 'react'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings, Repo, TuiAgent } from '../../../../shared/types'
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { runSourceControlAgentActionStart } from './runSourceControlAgentActionStart'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

type UseSourceControlAgentActionStartArgs = {
  selectedAgent: TuiAgent | null
  commandInput: string
  trimmedCommandInput: string
  agentArgs: string
  commandTemplate: string
  saveLaunchRecipe: boolean
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
  connectionUnavailable: boolean
  refreshDetectedAgents: () => Promise<TuiAgent[]>
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
  onLaunched?: () => void
  onClose: () => void
}

type SourceControlAgentActionStartWithDetectedAgentsArgs = {
  detectedAgents: TuiAgent[]
  saveTargetValueOverride?: string
}

type UseSourceControlAgentActionStartResult = {
  deliveryPlan: SourceControlAgentActionDeliveryPlanState
  resetDeliveryPlan: () => void
  isStarting: boolean
  handleStart: () => Promise<void>
  startWithDetectedAgents: (
    args: SourceControlAgentActionStartWithDetectedAgentsArgs
  ) => Promise<boolean>
}

export function useSourceControlAgentActionStart({
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
  onClose
}: UseSourceControlAgentActionStartArgs): UseSourceControlAgentActionStartResult {
  const [deliveryPlan, setDeliveryPlan] = useState<SourceControlAgentActionDeliveryPlanState>({
    status: 'idle'
  })
  const [isStarting, setIsStarting] = useState(false)
  const isStartingRef = useRef(false)
  const resetDeliveryPlan = useCallback(() => setDeliveryPlan({ status: 'idle' }), [])

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

  const startWithDetectedAgents = useCallback(
    async ({
      detectedAgents: nextAgents,
      saveTargetValueOverride
    }: SourceControlAgentActionStartWithDetectedAgentsArgs): Promise<boolean> => {
      if (!selectedAgent || isStartingRef.current) {
        return false
      }
      if (connectionUnavailable) {
        setDeliveryPlan(buildSourceControlAgentConnectionErrorPlan())
        return false
      }
      isStartingRef.current = true
      setIsStarting(true)
      try {
        const nextPlan = await buildPlan(nextAgents)
        if (nextPlan.status === 'error') {
          setDeliveryPlan(nextPlan)
          return false
        }
        setDeliveryPlan(nextPlan)
        return await runSourceControlAgentActionStart({
          selectedAgent,
          trimmedCommandInput,
          agentArgs,
          commandTemplate,
          saveTargetValue: saveLaunchRecipe ? (saveTargetValueOverride ?? saveTargetValue) : 'none',
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
          onClose: () => {
            resetDeliveryPlan()
            onClose()
          }
        })
      } finally {
        isStartingRef.current = false
        setIsStarting(false)
      }
    },
    [
      actionId,
      agentArgs,
      buildPlan,
      commandTemplate,
      connectionUnavailable,
      groupId,
      launchSource,
      launchPlatform,
      onClose,
      onLaunched,
      onSaveAgentDefault,
      onStart,
      promptDelivery,
      resetDeliveryPlan,
      repo,
      repoId,
      saveLaunchRecipe,
      saveTargetValue,
      settings,
      selectedAgent,
      trimmedCommandInput,
      worktreeId
    ]
  )

  const handleStart = useCallback(async () => {
    if (!selectedAgent || isStartingRef.current) {
      return
    }
    // Why: manual starts intentionally re-check the current host, while the
    // saved-receipt bypass reuses the detection result that unlocked it.
    const nextAgents = await refreshDetectedAgents()
    await startWithDetectedAgents({ detectedAgents: nextAgents })
  }, [refreshDetectedAgents, selectedAgent, startWithDetectedAgents])

  return { deliveryPlan, resetDeliveryPlan, isStarting, handleStart, startWithDetectedAgents }
}
