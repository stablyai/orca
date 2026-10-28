import type { AgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchChoice } from '@/lib/agent-menu-selection'
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import {
  runSourceControlAgentActionStart,
  type RunSourceControlAgentActionStartArgs
} from './runSourceControlAgentActionStart'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

type UseSourceControlAgentActionStartArgs = {
  open: boolean
  connectionId?: string | null
  selectedAgent: TuiAgent | null
  commandInput: string
  trimmedCommandInput: string
  agentArgs?: string
  /** False when the launch would be structured native chat, which reads no CLI arguments. */
  agentArgsApply: boolean
  recipe: SourceControlActionRecipe
  saveLaunchRecipe: boolean
  saveTargetValue: string
  actionId: SourceControlLaunchActionId
  repoId?: string | null
  agentLaunchPreferences: AgentLaunchPreferences
  settings: GlobalSettings | null
  repo: Pick<Repo, 'id' | 'sourceControlAi'> | null
  worktreeId?: string | null
  groupId?: string | null
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  /** SSH uses plain orca; omit the local Linux orca-ide rename in its preview. */
  isRemote?: boolean
  launchSource: LaunchSource
  recoveryContext?: RuntimeGitContext | null
  connectionUnavailable: boolean
  /** The dialog's one host observation; Start is gated on it having settled. */
  detectedAgents: TuiAgent[]
  /** The picker's choice as rendered when Start was pressed, captured before any await. */
  launchChoice?: AgentLaunchChoice
  onStart?: RunSourceControlAgentActionStartArgs['onStart']
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onLaunchAccepted?: () => void
  onLaunchAborted?: () => void
  onLaunched?: () => void
  onClose: () => void
}

type SourceControlAgentActionStartWithDetectedAgentsArgs = {
  detectedAgents: TuiAgent[]
}

type UseSourceControlAgentActionStartResult = {
  deliveryPlan: SourceControlAgentActionDeliveryPlanState
  resetDeliveryPlan: () => void
  cancelStart: () => void
  isStarting: boolean
  handleStart: () => Promise<void>
  startWithDetectedAgents: (
    args: SourceControlAgentActionStartWithDetectedAgentsArgs
  ) => Promise<boolean>
}

export function useSourceControlAgentActionStart({
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
  agentLaunchPreferences,
  repo,
  worktreeId,
  groupId,
  promptDelivery,
  launchPlatform,
  isRemote,
  launchSource,
  recoveryContext,
  connectionUnavailable,
  detectedAgents,
  launchChoice,
  onStart,
  onSaveAgentDefault,
  onLaunchAccepted,
  onLaunchAborted,
  onLaunched,
  onClose
}: UseSourceControlAgentActionStartArgs): UseSourceControlAgentActionStartResult {
  const [deliveryPlan, setDeliveryPlan] = useState<SourceControlAgentActionDeliveryPlanState>({
    status: 'idle'
  })
  const [isStarting, setIsStarting] = useState(false)
  const attemptRef = useRef<AbortController | null>(null)
  const resetDeliveryPlan = useCallback(() => setDeliveryPlan({ status: 'idle' }), [])
  const cancelStart = useCallback(() => {
    attemptRef.current?.abort()
    attemptRef.current = null
    setIsStarting(false)
  }, [])
  useEffect(() => cancelStart, [open, worktreeId, connectionId, actionId, cancelStart])

  const buildPlan = useCallback(
    (currentDetectedAgents: TuiAgent[]): SourceControlAgentActionDeliveryPlanState =>
      buildSourceControlAgentDeliveryPlan({
        settings,
        agentLaunchPreferences,
        selectedAgent,
        commandInput,
        // Why: the check must judge the arguments the launch will really apply.
        agentArgs: agentArgsApply ? agentArgs : undefined,
        detectedAgents: currentDetectedAgents,
        connectionUnavailable,
        launchPlatform,
        isRemote
      }),
    [
      settings,
      agentLaunchPreferences,
      agentArgs,
      agentArgsApply,
      commandInput,
      connectionUnavailable,
      selectedAgent,
      launchPlatform,
      isRemote
    ]
  )

  const startWithDetectedAgents = useCallback(
    async ({
      detectedAgents: nextAgents
    }: SourceControlAgentActionStartWithDetectedAgentsArgs): Promise<boolean> => {
      if (!open || !selectedAgent || attemptRef.current) {
        return false
      }
      if (connectionUnavailable) {
        setDeliveryPlan(buildSourceControlAgentConnectionErrorPlan())
        return false
      }
      const attempt = new AbortController()
      attemptRef.current = attempt
      setIsStarting(true)
      try {
        const nextPlan = buildPlan(nextAgents)
        if (nextPlan.status === 'error') {
          setDeliveryPlan(nextPlan)
          return false
        }
        setDeliveryPlan(nextPlan)
        return await runSourceControlAgentActionStart({
          selectedAgent,
          trimmedCommandInput,
          launchChoice,
          recipe,
          saveTargetValue: saveLaunchRecipe ? saveTargetValue : 'none',
          actionId,
          repoId,
          settings,
          agentLaunchPreferences,
          repo,
          worktreeId,
          groupId,
          promptDelivery,
          launchPlatform,
          launchSource,
          recoveryContext,
          signal: attempt.signal,
          onStart,
          onSaveAgentDefault,
          onLaunchAccepted,
          onLaunchAborted,
          onLaunched,
          onClose: () => {
            resetDeliveryPlan()
            onClose()
          }
        })
      } finally {
        if (attemptRef.current === attempt) {
          attemptRef.current = null
          setIsStarting(false)
        }
      }
    },
    [
      actionId,
      agentLaunchPreferences,
      buildPlan,
      launchChoice,
      recipe,
      connectionUnavailable,
      groupId,
      launchSource,
      recoveryContext,
      launchPlatform,
      onClose,
      onLaunchAborted,
      onLaunchAccepted,
      onLaunched,
      onSaveAgentDefault,
      onStart,
      open,
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
    await startWithDetectedAgents({ detectedAgents })
  }, [detectedAgents, startWithDetectedAgents])

  return {
    deliveryPlan,
    resetDeliveryPlan,
    cancelStart,
    isStarting,
    handleStart,
    startWithDetectedAgents
  }
}
