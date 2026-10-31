import type { AppState } from '@/store/types'
import type { AgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import type { ProspectiveWorkspace } from '@/lib/agent-launch-route-input'
import { readAgentLaunchChoice } from '@/lib/host-chat-program'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import type { SourceControlActionId } from '../../../shared/source-control-ai-actions'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '../../../shared/source-control-launch-agent-selection'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type {
  AgentMenuRowsTarget,
  NewTabAgentMenuModel
} from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import type { resolveAgentMenuSelection } from '@/lib/agent-menu-selection'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'

/** The workspace a Source Control agent picker lists rows for, and the host whose agents it reads. */
export type SourceControlAgentRows = {
  target: string | AgentMenuRowsTarget
  detectionTarget: AgentDetectionTarget | undefined
}

/** A launch into a workspace the repo does not have yet, named the way the create dialog names it. */
export function sourceControlRepoAgentRows(
  repo: Pick<Repo, 'id' | 'kind' | 'connectionId' | 'executionHostId'> | null
): SourceControlAgentRows {
  if (!repo) {
    // Why: no project row means no owning host to ask, so its rows stay unavailable.
    return { target: { workspace: { kind: 'git-worktree' } }, detectionTarget: undefined }
  }
  const executionHostId = getRepoExecutionHostId(repo)
  const host = parseExecutionHostId(executionHostId)
  return {
    target: {
      workspace: {
        kind: isFolderRepo(repo) ? 'folder' : 'git-worktree',
        repoId: repo.id,
        executionHostId
      }
    },
    // A paired server answers for its own projects; this client never stands in for it.
    detectionTarget:
      host?.kind === 'runtime'
        ? { kind: 'runtime', environmentId: host.environmentId }
        : host?.kind === 'ssh'
          ? { kind: 'ssh', connectionId: host.targetId }
          : { kind: 'local' }
  }
}

/**
 * What a pick saves: a surface only where the agent had a chat row, i.e. the user really chose
 * between its chat and its CLI. A plain-mode or CLI-only row saves nothing, so the action keeps
 * following the agent's settings route if chats become available later.
 */
export function savedSurfaceForPick(
  model: NewTabAgentMenuModel,
  agent: TuiAgent,
  surface: AgentLaunchSurface | undefined
): AgentLaunchSurface | undefined {
  const hadChoice =
    model.state === 'settled' &&
    model.rows.some((row) => row.agent === agent && row.kind === 'chat')
  return hadChoice ? surface : undefined
}

/** Editing waits for host facts, not for the saved agent to become launchable. */
export function sourceControlAgentPickerSelection(
  model: NewTabAgentMenuModel,
  selection: ReturnType<typeof resolveAgentMenuSelection>
): ReturnType<typeof resolveAgentMenuSelection> {
  return {
    ...selection,
    ready:
      model.state === 'settled' &&
      (model.detection.detectedIds !== null ||
        model.detection.detectionFailed ||
        model.detection.needsServerUpdate)
  }
}

/** Button gates and execution use the same recipe and preserve strict saved Checks choices. */
export function resolveChecksActionAgent(
  state: AppState,
  actionId: SourceControlActionId,
  repoId: string | undefined,
  workspace: ProspectiveWorkspace,
  detected: readonly TuiAgent[] | null,
  preferences?: AgentLaunchPreferences
): TuiAgent | null {
  const policy = preferences ?? state.settings
  const repo = state.repos.find((entry) => entry.id === repoId)
  const savedAgent = readSourceControlLaunchRecipeAgentId(
    resolveSourceControlActionRecipe({ settings: state.settings, repo, actionId })
  )
  const usable = (agent: TuiAgent): boolean =>
    isTuiAgentEnabled(agent, policy?.disabledTuiAgents) &&
    (detected?.includes(agent) === true ||
      readAgentLaunchChoice(state, agent, workspace, detected).chatEligibility !== 'no')
  if (savedAgent && actionId === 'fixChecks') {
    return usable(savedAgent) ? savedAgent : null
  }
  return pickSourceControlLaunchAgent({
    savedAgent,
    defaultAgent: policy?.defaultTuiAgent,
    detectedAgents: [...(detected ?? [])],
    disabledAgents: policy?.disabledTuiAgents,
    chosenOpensAsChat: usable
  })
}
