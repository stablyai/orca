import { acquireAgentLaunchChoices } from './host-chat-program-acquisition'
import { toast } from 'sonner'
import {
  ensureDetectedAgentsForRepo,
  ensureDetectedAgentsForWorktree,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { type ProspectiveWorkspace, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { readAgentLaunchChoice } from '@/lib/host-chat-program'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '../../../shared/source-control-launch-agent-selection'
import { resolveRepoWorktreeLaunchPlatform } from '@/lib/execution-host-facts'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from '../../../shared/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { AppState } from '@/store/types'
import type { SourceControlActionId } from '../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import {
  resolveSourceControlActionSessionOptions,
  sourceControlActionLaunchOptions,
  sourceControlActionAgentArgs
} from '../../../shared/source-control-action-launch-preferences'

type StartFixChecksAgentArgs = {
  repoId: string
  basePrompt: string
  item?: GitHubWorkItem
  worktreeId?: string | null
  groupId?: string | null
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  openModalFallback?: () => void
}

type SavedAgentOverrideResult =
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'launch-default' }
  | { kind: 'blocked' }

/** Button gates and execution use the same recipe and preserve strict saved Checks choices. */
export function resolveChecksActionAgent(
  state: AppState,
  actionId: SourceControlActionId,
  repoId: string | undefined,
  workspace: ProspectiveWorkspace,
  detected: readonly TuiAgent[] | null
): TuiAgent | null {
  const repo = state.repos.find((entry) => entry.id === repoId)
  const savedAgent = readSourceControlLaunchRecipeAgentId(
    resolveSourceControlActionRecipe({ settings: state.settings, repo, actionId })
  )
  const usable = (agent: TuiAgent): boolean =>
    isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents) &&
    (detected?.includes(agent) === true ||
      readAgentLaunchChoice(state, agent, workspace, detected).chatEligibility !== 'no')
  if (savedAgent && actionId === 'fixChecks') {
    return usable(savedAgent) ? savedAgent : null
  }
  return pickSourceControlLaunchAgent({
    savedAgent,
    defaultAgent: state.settings?.defaultTuiAgent,
    detectedAgents: [...(detected ?? [])],
    disabledAgents: state.settings?.disabledTuiAgents,
    chosenOpensAsChat: usable
  })
}

async function resolveSavedAgentOverride(
  savedAgentId: () => TuiAgent | null | undefined,
  repo: (RepoHostFields & { id: string }) | null
): Promise<SavedAgentOverrideResult> {
  if (!savedAgentId()) {
    return { kind: 'launch-default' }
  }
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  const workspace: ProspectiveWorkspace = {
    kind: 'git-worktree',
    ...(repo ? { repoId: repo.id, executionHostId: getRepoExecutionHostId(repo) } : {})
  }
  // Before workspace creation, paired projects can check enabled only; installation is checked on the created workspace’s host.
  const detected = pendingAgents
    ? (await acquireAgentLaunchChoices(workspace, () => pendingAgents)).detected
    : null
  const current = useAppStore.getState()
  const savedAgent = savedAgentId()
  if (!savedAgent) {
    return { kind: 'launch-default' }
  }
  const available = pendingAgents
    ? resolveChecksActionAgent(current, 'fixChecks', repo?.id, workspace, detected) === savedAgent
    : isTuiAgentEnabled(savedAgent, current.settings?.disabledTuiAgents)
  if (!available) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.4c7f783a7a',
        'Saved checks agent is not available on this workspace host.'
      )
    )
    return { kind: 'blocked' }
  }
  return { kind: 'agent', agent: savedAgent }
}

async function pickExistingWorktreeAgent(worktreeId: string): Promise<TuiAgent | null> {
  const workspace = worktreeLaunchWorkspace(worktreeId)
  const choices = await acquireAgentLaunchChoices(workspace, () =>
    ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId)
  )
  const state = useAppStore.getState()
  const repoId = state.allWorktrees().find((entry) => entry.id === worktreeId)?.repoId
  const agent = resolveChecksActionAgent(state, 'fixChecks', repoId, workspace, choices.detected)
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

export async function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
  const recipe = () =>
    resolveSourceControlActionRecipe({
      settings: useAppStore.getState().settings,
      repo: useAppStore.getState().repos.find((entry) => entry.id === args.repoId),
      actionId: 'fixChecks'
    })
  const savedAgentId = () => readSourceControlLaunchRecipeAgentId(recipe())
  const commandInput = (): string => {
    const prompt = renderSourceControlActionCommandTemplate(
      recipe().commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixChecks,
      { basePrompt: args.basePrompt }
    ).trim()
    if (!prompt) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.9f00d7df0c',
          'Fix checks prompt is empty. Update Source Control AI settings.'
        )
      )
    }
    return prompt
  }

  const attachedWorkspace =
    args.worktreeId || !args.item
      ? null
      : findGithubPrWorkspaceAttachment(
          store.allWorktrees(),
          args.repoId,
          args.item.number,
          args.item.url
        )
  const targetWorktreeId = args.worktreeId ?? attachedWorkspace?.id ?? null
  if (targetWorktreeId) {
    const targetWorktree = store.allWorktrees().find((worktree) => worktree.id === targetWorktreeId)
    if (!targetWorktree) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.dfb4dd7c00',
          'Unable to find the workspace attached to these checks.'
        )
      )
      return false
    }
    const agent = await pickExistingWorktreeAgent(targetWorktreeId)
    const prompt = agent ? commandInput() : ''
    if (!agent || !prompt) {
      return false
    }
    // Why: the agent runs on the workspace's execution host, so its OS decides quoting (#27971).
    const latestStore = useAppStore.getState()
    const targetRepo =
      latestStore.repos.find((candidate) => candidate.id === targetWorktree.repoId) ?? repo
    const launchPlatform = targetRepo
      ? resolveRepoWorktreeLaunchPlatform(latestStore, targetRepo, targetWorktree)
      : undefined
    if (!launchPlatform) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.822bf52295',
          'Unable to resolve the workspace launch platform.'
        )
      )
      return false
    }
    let revealFailed = false
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: targetWorktreeId,
      groupId: args.groupId ?? targetWorktreeId,
      prompt,
      agentArgs: sourceControlActionAgentArgs(recipe(), agent, useAppStore.getState().settings),
      ...sourceControlActionLaunchOptions(recipe(), agent),
      promptDelivery: 'submit-after-ready',
      launchPlatform,
      launchSource: args.launchSource,
      beforeSurfaceOpen: () => {
        // Why: the launcher owns the initial surface, so revealing must not seed a sibling shell.
        const revealed = activateAndRevealWorktree(targetWorktreeId, {
          providesInitialSurface: true
        })
        revealFailed = revealed === false
        return !revealFailed
      }
    })
    if (!result) {
      toast.error(
        revealFailed
          ? translate(
              'auto.lib.fix.checks.agent.launch.03c1d61f83',
              'Unable to open the workspace attached to these checks.'
            )
          : translate(
              'auto.lib.fix.checks.agent.launch.fb6c294e85',
              'Could not build the agent launch command.'
            )
      )
      return false
    }
    if (result.surface.kind === 'local-terminal') {
      focusTerminalTabSurface(result.surface.tabId)
    }
    return true
  }

  if (!args.item || !args.openModalFallback) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.027228a06b',
        'Unable to find a workspace for these checks.'
      )
    )
    return false
  }

  const agentOverride = await resolveSavedAgentOverride(savedAgentId, repo)
  const prompt = agentOverride.kind === 'blocked' ? '' : commandInput()
  if (!prompt) {
    return false
  }

  return await launchWorkItemDirect({
    item: { ...args.item, pasteContent: prompt },
    repoId: args.repoId,
    launchSource: args.launchSource,
    telemetrySource: args.telemetrySource,
    promptDelivery: 'submit-after-ready',
    agentArgs: recipe().agentArgs,
    resolveAgentArgs: (agent) =>
      sourceControlActionAgentArgs(recipe(), agent, useAppStore.getState().settings),
    resolveSessionOptions: (agent) => resolveSourceControlActionSessionOptions(recipe(), agent),
    sessionOptionsYieldToAgentArgs: recipe().launchPreferencesYieldToAgentArgs,
    ...(agentOverride.kind === 'agent' ? { agentOverride: agentOverride.agent } : {}),
    openModalFallback: args.openModalFallback
  })
}
