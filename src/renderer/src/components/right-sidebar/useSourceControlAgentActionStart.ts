import { projectSelectedSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'
import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree
} from '@/components/settings/use-host-agent-launch-preferences'
import { useAppStore } from '@/store'
import {
  detectionTargetForWorktree,
  ensureDetectedAgentsForTarget,
  agentInventoryAttemptKey,
  readAgentInventoryForTarget
} from '@/lib/agent-detection-target-inventory'
import { sourceControlRepoAgentRows } from '@/lib/source-control-agent-picker'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from '@/lib/host-chat-program-acquisition'
import { agentsOfferedForLaunch } from '@/lib/host-chat-program'
import { buildAgentLaunchRouteInput, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import type { AppState } from '@/store/types'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  UseSourceControlAgentActionStartArgs,
  SourceControlAgentActionStartWithDetectedAgentsArgs,
  UseSourceControlAgentActionStartResult
} from './source-control-agent-action-start-types'
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { runSourceControlAgentActionStart } from './runSourceControlAgentActionStart'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

export function useSourceControlAgentActionStart({
  open,
  connectionId,
  selectedAgent,
  commandInput,
  trimmedCommandInput,
  agentArgsApply,
  recipe,
  prepareRecipe,
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
  useEffect(
    () => cancelStart,
    [
      open,
      worktreeId,
      connectionId,
      actionId,
      selectedAgent,
      recipe.agentId,
      recipe.agentArgs,
      recipe.commandInputTemplate,
      recipe.surface,
      recipe.launchPreferences,
      recipe.launchPreferencesYieldToAgentArgs,
      launchChoice?.requestedSurface,
      cancelStart
    ]
  )

  const startWithDetectedAgents = useCallback(
    async (_args: SourceControlAgentActionStartWithDetectedAgentsArgs): Promise<boolean> => {
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
        const submitted = prepareRecipe ? prepareRecipe(selectedAgent) : recipe
        const targetFor = (state: AppState) =>
          worktreeId
            ? detectionTargetForWorktree(state, worktreeId)
            : repoId
              ? sourceControlRepoAgentRows(state.repos.find((entry) => entry.id === repoId) ?? null)
                  .detectionTarget
              : typeof connectionId === 'string'
                ? { kind: 'ssh' as const, connectionId }
                : { kind: 'local' as const }
        const initial = useAppStore.getState()
        const target = targetFor(initial)
        const key = agentInventoryAttemptKey(initial, target)
        if (!key || !target) {
          return false
        }
        const repoRows = sourceControlRepoAgentRows(
          initial.repos.find((entry) => entry.id === repoId) ?? null
        )
        const workspace = worktreeId
          ? worktreeLaunchWorkspace(worktreeId)
          : typeof repoRows.target === 'string'
            ? worktreeLaunchWorkspace(repoRows.target)
            : {
                ...repoRows.target.workspace,
                ...(typeof connectionId === 'string'
                  ? { executionHostId: `ssh:${connectionId}` }
                  : {})
              }
        if (
          launchChoice?.executionHostId &&
          launchChoice.executionHostId !==
            buildAgentLaunchRouteInput(initial, { agent: selectedAgent, workspace }).executionHostId
        ) {
          return false
        }
        await Promise.all([
          acquireAgentLaunchChoices(
            workspace,
            () => ensureDetectedAgentsForTarget(useAppStore.getState(), target),
            attempt.signal
          ),
          ensureAgentLaunchPreferences(initial, workspace, attempt.signal)
        ])
        const validateBeforeLaunch = async () => {
          if (
            attempt.signal.aborted ||
            key !==
              agentInventoryAttemptKey(useAppStore.getState(), targetFor(useAppStore.getState()))
          ) {
            return null
          }
          const acquiredPreferences = worktreeId
            ? null
            : await ensureAgentLaunchPreferences(useAppStore.getState(), workspace, attempt.signal)
          const current = useAppStore.getState()
          if (key !== agentInventoryAttemptKey(current, targetFor(current))) {
            return null
          }
          const currentPreferences = worktreeId
            ? readAgentLaunchPreferencesForWorktree(current, worktreeId)
            : target.kind === 'runtime' && acquiredPreferences
              ? acquiredPreferences
              : {
                  defaultTuiAgent: current.settings?.defaultTuiAgent,
                  disabledTuiAgents: current.settings?.disabledTuiAgents
                }
          const inventory = readAgentInventoryForTarget(current, target)
          const nextPlan = buildSourceControlAgentDeliveryPlan({
            settings: current.settings,
            agentLaunchPreferences: currentPreferences,
            selectedAgent,
            commandInput,
            agentArgs: agentArgsApply
              ? projectSelectedSourceControlActionLaunch(submitted, selectedAgent, {
                  renderedPrompt: commandInput,
                  settings: current.settings
                }).agentArgs
              : undefined,
            detectedAgents: agentArgsApply
              ? [...(inventory.ids ?? [])]
              : agentsOfferedForLaunch(current, workspace, inventory.ids),
            explicitInventoryFailed:
              recipe.agentId === selectedAgent && inventory.state === 'failed',
            connectionUnavailable,
            launchPlatform,
            isRemote
          })
          setDeliveryPlan(nextPlan)
          return nextPlan.status === 'error'
            ? null
            : {
                settings: current.settings,
                agentLaunchPreferences: currentPreferences,
                repo: current.repos.find((entry) => entry.id === repoId) ?? null
              }
        }
        const current = await validateBeforeLaunch()
        if (!current) {
          return false
        }
        return await runSourceControlAgentActionStart({
          selectedAgent,
          trimmedCommandInput,
          launchChoice,
          recipe: submitted,
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
          validateBeforeLaunch,
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
      } catch (error) {
        if (
          attempt.signal.aborted ||
          error instanceof AgentLaunchChoiceCancelled ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return false
        }
        throw error
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
      agentArgsApply,
      commandInput,
      connectionId,
      isRemote,
      launchChoice,
      recipe,
      prepareRecipe,
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
