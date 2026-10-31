import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree,
  type AgentLaunchPreferences
} from '@/components/settings/use-host-agent-launch-preferences'
import { resolveChecksActionAgent } from '@/lib/source-control-agent-picker'
import { acquireAgentLaunchChoices } from './host-chat-program-acquisition'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { toast } from 'sonner'
import {
  ensureDetectedAgentsForRepo,
  detectionTargetForRepo,
  detectionTargetForWorktree,
  agentInventoryAttemptKey,
  readAgentInventoryForTarget,
  ensureDetectedAgentsForWorktree,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'
import { type ProspectiveWorkspace, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { readSourceControlLaunchRecipeAgentId } from '../../../shared/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

type SavedAgentOverrideResult =
  | { kind: 'agent'; agent: TuiAgent; preferences: AgentLaunchPreferences }
  | { kind: 'launch-default' }
  | { kind: 'blocked' }

export async function resolveSavedAgentOverride(
  savedAgentId: () => TuiAgent | null | undefined,
  repo: (RepoHostFields & { id: string }) | null,
  workspace: ProspectiveWorkspace,
  preferencesPromise: Promise<AgentLaunchPreferences>
): Promise<SavedAgentOverrideResult> {
  if (!savedAgentId()) {
    return { kind: 'launch-default' }
  }
  const initialAgent = savedAgentId()
  const target = detectionTargetForRepo(repo ?? {})
  const attemptKey = agentInventoryAttemptKey(useAppStore.getState(), target)
  const initialHost = getRepoExecutionHostId(repo ?? {})
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  // Why: a paired server answers per workspace, so only the enabled check can run before it exists;
  // the direct launch checks installation on the new workspace.
  const [choices] = await Promise.all([
    pendingAgents ? acquireAgentLaunchChoices(workspace, () => pendingAgents) : null,
    preferencesPromise
  ])
  const acquiredPreferences = await ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  const detected = choices?.detected ?? null
  const current = useAppStore.getState()
  const currentRepo = current.repos.find((entry) => entry.id === repo?.id)
  const currentTarget = currentRepo ? detectionTargetForRepo(currentRepo) : undefined
  const sameSource =
    Boolean(currentRepo) &&
    getRepoExecutionHostId(currentRepo ?? {}) === initialHost &&
    JSON.stringify(currentTarget) === JSON.stringify(target) &&
    (!target ||
      (attemptKey !== null && attemptKey === agentInventoryAttemptKey(current, currentTarget)))
  const preferences = initialHost?.startsWith('runtime:')
    ? acquiredPreferences
    : {
        defaultTuiAgent: current.settings?.defaultTuiAgent,
        disabledTuiAgents: current.settings?.disabledTuiAgents
      }
  const savedAgent = savedAgentId()
  if (!sameSource || savedAgent !== initialAgent) {
    return { kind: 'blocked' }
  }
  if (!savedAgent) {
    return { kind: 'launch-default' }
  }
  const available = pendingAgents
    ? resolveChecksActionAgent(
        current,
        'fixChecks',
        repo?.id,
        workspace,
        detected,
        preferences,
        !!currentTarget && readAgentInventoryForTarget(current, currentTarget).state === 'failed'
      ) === savedAgent
    : isTuiAgentEnabled(savedAgent, preferences.disabledTuiAgents)
  if (!available) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.4c7f783a7a',
        'Saved checks agent is not available on this workspace host.'
      )
    )
    return { kind: 'blocked' }
  }
  return { kind: 'agent', agent: savedAgent, preferences }
}

export async function pickExistingWorktreeAgent(worktreeId: string): Promise<TuiAgent | null> {
  const workspace = worktreeLaunchWorkspace(worktreeId)
  const before = useAppStore.getState()
  const target = detectionTargetForWorktree(before, worktreeId)
  const attemptKey = agentInventoryAttemptKey(before, target)
  const repoBefore = before.allWorktrees().find((entry) => entry.id === worktreeId)?.repoId
  const initialAgent = readSourceControlLaunchRecipeAgentId(
    resolveSourceControlActionRecipe({
      settings: before.settings,
      repo: before.repos.find((entry) => entry.id === repoBefore),
      actionId: 'fixChecks'
    })
  )
  const [choices] = await Promise.all([
    acquireAgentLaunchChoices(workspace, () =>
      ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId)
    ),
    ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  ])
  const state = useAppStore.getState()
  const repoId = state.allWorktrees().find((entry) => entry.id === worktreeId)?.repoId
  const currentTarget = detectionTargetForWorktree(state, worktreeId)
  if (!attemptKey || attemptKey !== agentInventoryAttemptKey(state, currentTarget)) {
    return null
  }
  const preferences = readAgentLaunchPreferencesForWorktree(state, worktreeId)
  const currentAgent = readSourceControlLaunchRecipeAgentId(
    resolveSourceControlActionRecipe({
      settings: state.settings,
      repo: state.repos.find((entry) => entry.id === repoId),
      actionId: 'fixChecks'
    })
  )
  if (initialAgent !== currentAgent) {
    return null
  }
  const agent = resolveChecksActionAgent(
    state,
    'fixChecks',
    repoId,
    workspace,
    choices.detected,
    preferences,
    !!currentTarget && readAgentInventoryForTarget(state, currentTarget).state === 'failed'
  )
  if (!agent) {
    const repo = state.repos.find((entry) => entry.id === repoId)
    const savedAgent = readSourceControlLaunchRecipeAgentId(
      resolveSourceControlActionRecipe({ settings: state.settings, repo, actionId: 'fixChecks' })
    )
    toast.error(
      savedAgent
        ? translate(
            'auto.lib.fix.checks.agent.launch.4c7f783a7a',
            'Saved checks agent is not available on this workspace host.'
          )
        : translate(
            'auto.lib.fix.checks.agent.launch.2ebf794906',
            'No enabled AI agent was detected on this workspace host.'
          )
    )
  }
  return agent
}
