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
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { runSourceControlAgentActionStart } from './runSourceControlAgentActionStart'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

type UseSourceControlAgentActionStartArgs = {
  open: boolean
  connectionId?: string | null
  selectedAgent: TuiAgent | null
  commandInput: string
  trimmedCommandInput: string
  agentArgs: string
  /** False when the launch would be structured native chat, which reads no CLI arguments. */
  agentArgsApply: boolean
  recipe: SourceControlActionRecipe
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
  /** SSH uses plain orca; omit the local Linux orca-ide rename in its preview. */
  isRemote?: boolean
  launchSource: LaunchSource
  recoveryContext?: RuntimeGitContext | null
  connectionUnavailable: boolean
  refreshDetectedAgents: () => Promise<TuiAgent[]>
  onStart?: (args: {
    agent: TuiAgent
    commandInput: string
    /** Omitted when CLI arguments do not apply, so the launch resolves the global setting. */
    agentArgs?: string
    /** The action's saved choice, on either route. */
    sessionOptions?: Readonly<Record<string, string>>
    sessionOptionsYieldToAgentArgs?: true
  }) => boolean | Promise<boolean>
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
  detectedAgents?: TuiAgent[]
  saveTargetValueOverride?: string
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
  repo,
  worktreeId,
  groupId,
  promptDelivery,
  launchPlatform,
  isRemote,
  launchSource,
  recoveryContext,
  connectionUnavailable,
  refreshDetectedAgents,
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

  const startWithDetectedAgents = useCallback(
    async ({
      detectedAgents: nextAgents,
      saveTargetValueOverride
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
        const detectedAgents = nextAgents ?? (await refreshDetectedAgents())
        if (attempt.signal.aborted) {
          return false
        }
        const nextPlan = buildSourceControlAgentDeliveryPlan({
          selectedAgent,
          commandInput,
          agentArgs: agentArgsApply ? agentArgs : undefined,
          detectedAgents,
          connectionUnavailable,
          launchPlatform,
          isRemote
        })
        if (nextPlan.status === 'error') {
          setDeliveryPlan(nextPlan)
          return false
        }
        setDeliveryPlan(nextPlan)
        return await runSourceControlAgentActionStart({
          selectedAgent,
          trimmedCommandInput,
          agentArgs,
          agentArgsApply,
          recipe,
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
      agentArgs,
      agentArgsApply,
      commandInput,
      recipe,
      connectionUnavailable,
      groupId,
      isRemote,
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
      refreshDetectedAgents,
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
    await startWithDetectedAgents({})
  }, [startWithDetectedAgents])

  return {
    deliveryPlan,
    resetDeliveryPlan,
    cancelStart,
    isStarting,
    handleStart,
    startWithDetectedAgents
  }
}
