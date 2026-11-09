import type { StartFixChecksAgentArgs } from './fix-checks-agent-launch-request'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { AgentLaunchPreferences } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import {
  resolveChecksActionAgent,
  sourceControlRepoAgentRows
} from '@/lib/source-control/ai/source-control-agent-picker'
export { resolveChecksActionAgent } from '@/lib/source-control/ai/source-control-agent-picker'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from './host-chat-program-acquisition'
import { toast } from 'sonner'
import {
  ensureDetectedAgentsForRepo,
  ensureDetectedAgentsForWorktree,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import type { ProspectiveWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { worktreeLaunchWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { findGithubPrWorkspaceAttachment } from '@/lib/work-items/github/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-session/launch/routing/agent-launch-request-id'
import { launchWorkItemDirect } from '@/lib/workspace/creation/work-item/launch-work-item-direct'
import { readSourceControlLaunchRecipeAgentId } from '../../../shared/source-control/ai/source-control-launch-agent-selection'
import { resolveRepoWorktreeLaunchPlatform } from '@/runtime/hosts/platform/execution-host-facts'
import { reportAgentWorkspaceActivation } from '@/lib/workspace/activation/worktree-activation-outcome'
import { activateAndRevealWorktreeWithOutcome } from '@/lib/workspace/activation/worktree-activation'
import { useAppStore } from '@/store'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control/ai/source-control-ai-operation-policy'
import {
  type SourceControlActionRecipe,
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from '../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { translate } from '@/i18n/i18n'
import { projectSourceControlActionLaunch } from '../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'

type SavedAgentOverrideResult =
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'launch-default' }
  | { kind: 'blocked' }

async function resolveSavedAgentOverride(
  savedAgentId: () => TuiAgent | null | undefined,
  repo: (RepoHostFields & { id: string }) | null,
  workspace: ProspectiveWorkspace,
  preferencesPromise: Promise<AgentLaunchPreferences>,
  recipe: SourceControlActionRecipe
): Promise<SavedAgentOverrideResult> {
  if (!savedAgentId()) {
    return { kind: 'launch-default' }
  }
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  // Paired installation can only be checked after its workspace exists.
  const [choices, preferences] = await Promise.all([
    pendingAgents ? acquireAgentLaunchChoices(workspace, () => pendingAgents) : null,
    preferencesPromise
  ])
  const detected = choices?.detected ?? null
  const current = useAppStore.getState()
  const savedAgent = savedAgentId()
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
        recipe
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
  return { kind: 'agent', agent: savedAgent }
}

async function pickExistingWorktreeAgent(
  worktreeId: string,
  recipe: SourceControlActionRecipe
): Promise<TuiAgent | null> {
  const workspace = worktreeLaunchWorkspace(worktreeId)
  const [choices, preferences] = await Promise.all([
    acquireAgentLaunchChoices(workspace, () =>
      ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId)
    ),
    ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  ])
  const state = useAppStore.getState()
  const repoId = state.allWorktrees().find((entry) => entry.id === worktreeId)?.repoId
  const agent = resolveChecksActionAgent(
    state,
    'fixChecks',
    repoId,
    workspace,
    choices.detected,
    preferences,
    recipe
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

export function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  return launchFixChecksAgent(args).catch((error) => {
    if (
      error instanceof AgentLaunchChoiceCancelled ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      return false
    }
    throw error
  })
}

async function launchFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
  const recipe = structuredClone(
    resolveSourceControlActionRecipe({
      settings: store.settings,
      repo,
      actionId: 'fixChecks'
    })
  )
  const savedAgentId = () => readSourceControlLaunchRecipeAgentId(recipe)
  const commandInput = (): string => {
    const prompt = renderSourceControlActionCommandTemplate(
      recipe.commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixChecks,
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
    const agent = await pickExistingWorktreeAgent(targetWorktreeId, recipe)
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
    const { commandInput: projectedPrompt, ...projection } = projectSourceControlActionLaunch(
      recipe,
      agent,
      { renderedPrompt: prompt, settings: store.settings }
    )
    let revealFailed = false
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: targetWorktreeId,
      groupId: args.groupId ?? targetWorktreeId,
      prompt: projectedPrompt,
      ...projection,
      promptDelivery: 'submit-after-ready',
      launchPlatform,
      launchSource: args.launchSource,
      beforeSurfaceOpen: () => {
        // Why: the launcher owns the initial surface, so revealing must not seed a sibling shell.
        const revealed = activateAndRevealWorktreeWithOutcome(targetWorktreeId, {
          providesInitialSurface: true
        })
        revealFailed = !reportAgentWorkspaceActivation(
          revealed,
          agent,
          translate(
            'auto.lib.fix.checks.agent.launch.03c1d61f83',
            'Unable to open the workspace attached to these checks.'
          )
        )
        return !revealFailed
      }
    })
    if (!result || 'refused' in result) {
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

  const { target } = sourceControlRepoAgentRows(repo)
  const workspace = typeof target === 'string' ? worktreeLaunchWorkspace(target) : target.workspace
  const preferences = ensureAgentLaunchPreferences(store, workspace)
  const [agentOverride, agentLaunchPreferences] = await Promise.all([
    resolveSavedAgentOverride(savedAgentId, repo, workspace, preferences, recipe),
    preferences
  ])
  const prompt = agentOverride.kind === 'blocked' ? '' : commandInput()
  if (!prompt) {
    return false
  }

  const result = await launchWorkItemDirect({
    item: { ...args.item, pasteContent: prompt },
    repoId: args.repoId,
    agentLaunchPreferences,
    launchSource: args.launchSource,
    telemetrySource: args.telemetrySource,
    promptDelivery: 'submit-after-ready',
    resolveLaunchInputs: (agent) =>
      projectSourceControlActionLaunch(recipe, agent, {
        renderedPrompt: prompt,
        settings: store.settings
      }),
    ...(agentOverride.kind === 'agent' ? { agentOverride: agentOverride.agent } : {}),
    openModalFallback: args.openModalFallback,
    onSetupRequired: args.onSetupRequired
  })
  return result === true
}
