import {
  selectSourceControlActionRecipe,
  type CurrentActionSelection
} from '../../../../shared/source-control-action-selection'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from '@/lib/host-chat-program-acquisition'
import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree
} from '@/components/settings/use-host-agent-launch-preferences'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  detectionTargetForWorktree,
  agentInventoryAttemptKey,
  readAgentInventoryForTarget,
  ensureDetectedAgentsForWorktree
} from '@/lib/agent-detection-target-inventory'
import { agentsOfferedForLaunch } from '@/lib/host-chat-program'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { projectSelectedSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'
import { sourceControlLaunchAppliesAgentArgs } from './source-control-launch-agent-args-applicability'
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'
import {
  runSourceControlAgentActionStart,
  type RunSourceControlAgentActionStartArgs
} from './runSourceControlAgentActionStart'

/** Primary events own saved starts; opening an editor never authorizes execution. */
type SavedStartArgs = Omit<
  RunSourceControlAgentActionStartArgs,
  'selectedAgent' | 'trimmedCommandInput' | 'saveTargetValue' | 'recipe'
> & {
  selection: CurrentActionSelection
  basePrompt: string
  connectionId?: string | null
  onFallback: () => void
}

export function useSavedSourceControlActionStart() {
  const inFlight = useRef(false)
  const [isStarting, setIsStarting] = useState(false)
  const start = async (input: SavedStartArgs | (() => SavedStartArgs)): Promise<void> => {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setIsStarting(true)
    let onFallback = (): void => {}
    let signal: AbortSignal | undefined
    try {
      const args = typeof input === 'function' ? input() : input
      signal = args.signal
      onFallback = () => {
        if (!signal?.aborted) {
          args.onFallback()
        }
      }
      signal?.throwIfAborted()
      const store = useAppStore.getState()
      const { worktreeId } = args
      const recipe = selectSourceControlActionRecipe(args.selection)
      const agent = recipe.agentId
      if (!isTuiAgent(agent) || !worktreeId) {
        onFallback()
        return
      }
      const target = detectionTargetForWorktree(store, worktreeId)
      const attemptKey = agentInventoryAttemptKey(store, target)
      if (!target || !attemptKey) {
        onFallback()
        return
      }
      const workspace = { worktreeId, kind: workspaceKindForWorktreeId(worktreeId) }
      const [choices] = await Promise.all([
        acquireAgentLaunchChoices(
          workspace,
          () => ensureDetectedAgentsForWorktree(store, worktreeId),
          signal
        ),
        ensureAgentLaunchPreferences(store, workspace, signal)
      ])
      signal?.throwIfAborted()
      const current = useAppStore.getState()
      if (
        attemptKey !==
        agentInventoryAttemptKey(current, detectionTargetForWorktree(current, worktreeId))
      ) {
        onFallback()
        return
      }
      const projection = projectSelectedSourceControlActionLaunch(recipe, agent, {
        basePrompt: args.basePrompt,
        settings: current.settings
      })
      const agentLaunchPreferences = readAgentLaunchPreferencesForWorktree(current, worktreeId)
      const route = isTuiAgent(agent)
        ? buildAgentLaunchRouteInput(current, {
            agent,
            workspace: {
              worktreeId: worktreeId ?? undefined,
              kind: workspaceKindForWorktreeId(worktreeId ?? '')
            }
          })
        : null
      const appliesArgs =
        recipe.surface === 'terminal' ||
        sourceControlLaunchAppliesAgentArgs({
          agent: isTuiAgent(agent) ? agent : null,
          worktreeId,
          repoId: args.repoId
        })
      const detectedAgents = appliesArgs ? [...(choices.detected ?? [])] : choices.offered
      const validateBeforeLaunch = () => {
        if (signal?.aborted) {
          return null
        }
        const state = useAppStore.getState()
        if (
          attemptKey !==
          agentInventoryAttemptKey(state, detectionTargetForWorktree(state, worktreeId))
        ) {
          return null
        }
        const currentRepo = state.repos.find((entry) => entry.id === args.repoId) ?? null
        const saved = resolveSourceControlActionRecipe({
          settings: state.settings,
          repo: currentRepo,
          actionId: args.actionId
        })
        if (saved.agentId !== agent) {
          return null
        }
        const inventory = readAgentInventoryForTarget(state, target)
        const preferences = readAgentLaunchPreferencesForWorktree(state, worktreeId)
        const currentProjection = projectSelectedSourceControlActionLaunch(recipe, agent, {
          basePrompt: args.basePrompt,
          settings: state.settings
        })
        const plan = buildSourceControlAgentDeliveryPlan({
          settings: state.settings,
          agentLaunchPreferences: preferences,
          selectedAgent: agent,
          commandInput: projection.commandInput,
          agentArgs: appliesArgs ? currentProjection.agentArgs : undefined,
          detectedAgents: appliesArgs
            ? [...(inventory.ids ?? [])]
            : agentsOfferedForLaunch(state, workspace, inventory.ids),
          explicitInventoryFailed: inventory.state === 'failed',
          connectionUnavailable: args.connectionId === undefined,
          launchPlatform: args.launchPlatform,
          isRemote: typeof args.connectionId === 'string'
        })
        if (plan.status === 'error') {
          toast.error(plan.error)
          return null
        }
        return { settings: state.settings, agentLaunchPreferences: preferences, repo: currentRepo }
      }
      const plan = buildSourceControlAgentDeliveryPlan({
        settings: current.settings,
        explicitInventoryFailed: readAgentInventoryForTarget(current, target).state === 'failed',
        agentLaunchPreferences,
        selectedAgent: agent,
        commandInput: projection.commandInput,
        agentArgs: appliesArgs ? projection.agentArgs : undefined,
        detectedAgents,
        connectionUnavailable: args.connectionId === undefined,
        launchPlatform: args.launchPlatform,
        isRemote: typeof args.connectionId === 'string'
      })
      if (plan.status === 'error') {
        toast.error(plan.error)
        onFallback()
        return
      }
      const launched = await runSourceControlAgentActionStart({
        ...args,
        recipe,
        agentLaunchPreferences,
        selectedAgent: agent,
        trimmedCommandInput: projection.commandInput,
        launchChoice: {
          agent,
          route: appliesArgs ? 'terminal-tui' : 'structured-native-chat',
          requestedSurface: projection.requestedSurface,
          executionHostId: route ? parseExecutionHostId(route.executionHostId)?.id : undefined
        },
        saveTargetValue: 'none',
        validateBeforeLaunch
      })
      if (!launched) {
        onFallback()
      }
    } catch (error) {
      if (
        signal?.aborted ||
        error instanceof AgentLaunchChoiceCancelled ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return
      }
      console.error('Saved Source Control action failed', error)
      onFallback()
    } finally {
      inFlight.current = false
      setIsStarting(false)
    }
  }
  return { start, isStarting }
}
