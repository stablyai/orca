import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { pickSourceControlLaunchAgent } from '../../../../shared/source-control-launch-agent-selection'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import {
  sourceControlRepoAgentRows,
  sourceControlAgentPickerSelection,
  type SourceControlAgentRows
} from '@/lib/source-control-agent-picker'
import { isSourceControlAgentDetectedAndEnabled } from './source-control-agent-action-dialog-support'

const NO_AGENTS: TuiAgent[] = []
// Why: a launch named by neither workspace nor project runs on this machine, as it always has.
const NO_PROJECT_ROWS: SourceControlAgentRows = {
  target: { workspace: { kind: 'git-worktree' } },
  detectionTarget: { kind: 'local' }
}

/**
 * The agent, route and rows a Source Control dialog starts with, from the one host observation the
 * "+" menu reads: the workspace's host, or the repo's host for a workspace not created yet.
 */
export function useSourceControlActionAgentChoice(args: {
  open: boolean
  worktreeId?: string | null
  repoId?: string | null
  repo: Pick<Repo, 'id' | 'kind' | 'connectionId' | 'executionHostId'> | null
  recipe: SourceControlActionRecipe
  /** This open's deliberate pick; absent replays the saved recipe. */
  livePick: AgentLaunchSurface | undefined
  settings: GlobalSettings | null
}) {
  const { recipe, settings } = args
  const worktreeDetectionTarget = useAgentDetectionTargetForWorktree(args.worktreeId ?? null)
  const rows = useMemo(
    () =>
      args.worktreeId
        ? { target: args.worktreeId, detectionTarget: worktreeDetectionTarget }
        : args.repoId
          ? sourceControlRepoAgentRows(args.repo)
          : NO_PROJECT_ROWS,
    [args.worktreeId, args.repoId, args.repo, worktreeDetectionTarget]
  )
  const observation = useAgentMenuObservation(rows.target, args.open, rows.detectionTarget)
  const { detectedIds, detectionFailed, needsServerUpdate } = observation.detection
  const detectedAgents =
    observation.model.state === 'settled'
      ? [
          ...new Set(
            observation.model.rows
              .filter((row) => row.kind !== 'chat-unavailable')
              .map((row) => row.agent)
          )
        ]
      : (detectedIds ?? NO_AGENTS)
  const detecting = detectedIds === null && !detectionFailed && !needsServerUpdate
  const { preferences } = observation
  const disabledAgents = preferences.disabledTuiAgents
  const selectedAgent =
    recipe.agentId && !isCustomAgentId(recipe.agentId)
      ? recipe.agentId
      : pickSourceControlLaunchAgent({
          defaultAgent: preferences.defaultTuiAgent,
          detectedAgents: detectedIds ?? NO_AGENTS,
          disabledAgents,
          chosenOpensAsChat: (agent) =>
            observation.model.state === 'settled' &&
            observation.model.rows.some((row) => row.kind === 'chat' && row.agent === agent)
        })
  // A saved chat stays implicit so a host that stops running chats falls back to a terminal.
  const liveSurface = args.livePick ?? (recipe.surface === 'terminal' ? 'terminal' : undefined)
  const selection = observation.selectionFor(selectedAgent, liveSurface)
  const enabledDetectedAgents = detectedAgents.filter((agent) =>
    isTuiAgentEnabled(agent, disabledAgents)
  )
  const selectedAgentUnavailable =
    !detecting &&
    Boolean(
      selectedAgent &&
      !isSourceControlAgentDetectedAndEnabled(selectedAgent, detectedAgents, disabledAgents)
    )
  const route = buildAgentLaunchRouteInput(useAppStore.getState(), {
    agent: selectedAgent ?? 'claude',
    workspace: args.worktreeId
      ? { worktreeId: args.worktreeId, kind: workspaceKindForWorktreeId(args.worktreeId) }
      : typeof rows.target === 'string'
        ? { worktreeId: rows.target, kind: workspaceKindForWorktreeId(rows.target) }
        : rows.target.workspace
  })
  return {
    observation,
    canSaveSurface:
      isNativeChatEnabled(settings) &&
      route.hostCapabilities?.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY) === true,
    detectedAgents,
    detecting,
    selectedAgent,
    liveSurface,
    selection,
    pickerSelection: sourceControlAgentPickerSelection(observation.model, selection),
    selectedAgentUnavailable,
    hasEnabledAgents: enabledDetectedAgents.length > 0,
    agentOptions: getAgentCatalog().filter(
      (entry) => enabledDetectedAgents.includes(entry.id) || entry.id === selectedAgent
    ),
    // Why the captured route, not `selection.cli`: plain mode labels no row "(CLI)" yet applies them.
    launchAppliesAgentArgs: selection.choice?.route !== 'structured-native-chat'
  }
}
