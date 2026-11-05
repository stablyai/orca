import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { AgentLaunchPreferences } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import {
  resolveChecksActionAgent,
  sourceControlRepoAgentRows
} from '@/lib/source-control-agent-picker'
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
import { type ProspectiveWorkspace, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { readSourceControlLaunchRecipeAgentId } from '../../../shared/source-control/ai/source-control-launch-agent-selection'
import { resolveRepoWorktreeLaunchPlatform } from '@/lib/execution-host-facts'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { SourceControlActionRecipe } from '../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../shared/agent-launch/catalog/tui-agent-selection'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import { projectSourceControlActionLaunch } from '../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'

/** Caller-specific wording, so each entry point names what the user acted on. */
export type PullRequestAgentPromptLaunchMessages = {
  savedAgentUnavailable: () => string
  workspaceMissing: () => string
  workspaceRevealFailed: () => string
  noWorkspace: () => string
}

export type PullRequestAgentPromptLaunchArgs = {
  repoId: string
  /** Captured by the caller so a settings edit mid-launch cannot change the agent or its args. */
  recipe: SourceControlActionRecipe
  /** Rendered once an agent is chosen; an empty result aborts (the caller reports why). */
  renderPrompt: () => string
  item?: GitHubWorkItem
  worktreeId?: string | null
  groupId?: string | null
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  openModalFallback?: () => void
  onSetupRequired?: () => void
  messages: PullRequestAgentPromptLaunchMessages
}

type SavedAgentOverrideResult =
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'launch-default' }
  | { kind: 'blocked' }

// Why: 'fixChecks' is the action whose saved agent is strict, which every PR prompt launch keeps.
const STRICT_SAVED_AGENT_ACTION_ID = 'fixChecks'

async function resolveSavedAgentOverride(
  recipe: SourceControlActionRecipe,
  repo: (RepoHostFields & { id: string }) | null,
  workspace: ProspectiveWorkspace,
  preferencesPromise: Promise<AgentLaunchPreferences>,
  messages: PullRequestAgentPromptLaunchMessages
): Promise<SavedAgentOverrideResult> {
  const savedAgent = readSourceControlLaunchRecipeAgentId(recipe)
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  // Why: a paired server answers per workspace, so its default is resolved after creation.
  if (!savedAgent && !pendingAgents) {
    return { kind: 'launch-default' }
  }
  // Why: a paired server answers per workspace, so only the enabled check can run before it exists;
  // the direct launch checks installation on the new workspace.
  const [choices, preferences] = await Promise.all([
    pendingAgents ? acquireAgentLaunchChoices(workspace, () => pendingAgents) : null,
    preferencesPromise
  ])
  const pickedAgent = pendingAgents
    ? resolveChecksActionAgent(
        useAppStore.getState(),
        STRICT_SAVED_AGENT_ACTION_ID,
        repo?.id,
        workspace,
        choices?.detected ?? null,
        preferences,
        recipe
      )
    : null
  if (!savedAgent) {
    // Why: same pick as an existing workspace, so a prompt is never dropped for want of an agent.
    if (!pickedAgent) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.2ebf794906',
          'No enabled AI agent was detected on this workspace host.'
        )
      )
      return { kind: 'blocked' }
    }
    return { kind: 'agent', agent: pickedAgent }
  }
  const available = pendingAgents
    ? pickedAgent === savedAgent
    : isTuiAgentEnabled(savedAgent, preferences.disabledTuiAgents)
  if (!available) {
    toast.error(messages.savedAgentUnavailable())
    return { kind: 'blocked' }
  }
  return { kind: 'agent', agent: savedAgent }
}

async function pickExistingWorktreeAgent(
  worktreeId: string,
  recipe: SourceControlActionRecipe,
  messages: PullRequestAgentPromptLaunchMessages
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
    STRICT_SAVED_AGENT_ACTION_ID,
    repoId,
    workspace,
    choices.detected,
    preferences,
    recipe
  )
  if (!agent) {
    toast.error(
      readSourceControlLaunchRecipeAgentId(recipe)
        ? messages.savedAgentUnavailable()
        : translate(
            'auto.lib.fix.checks.agent.launch.2ebf794906',
            'No enabled AI agent was detected on this workspace host.'
          )
    )
  }
  return agent
}

/**
 * Starts an agent for a pull request and submits the prompt once it is ready: in the
 * requested or PR-attached workspace when there is one, otherwise in a new workspace for the PR.
 */
export function launchPullRequestAgentPrompt(
  args: PullRequestAgentPromptLaunchArgs
): Promise<boolean> {
  return launchPullRequestAgentPromptUnchecked(args).catch((error) => {
    if (
      error instanceof AgentLaunchChoiceCancelled ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      return false
    }
    throw error
  })
}

async function launchPullRequestAgentPromptUnchecked(
  args: PullRequestAgentPromptLaunchArgs
): Promise<boolean> {
  const { messages, recipe } = args
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
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
      toast.error(messages.workspaceMissing())
      return false
    }
    const agent = await pickExistingWorktreeAgent(targetWorktreeId, recipe, messages)
    const prompt = agent ? args.renderPrompt() : ''
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
          ? messages.workspaceRevealFailed()
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
    toast.error(messages.noWorkspace())
    return false
  }

  const { target } = sourceControlRepoAgentRows(repo)
  const workspace = typeof target === 'string' ? worktreeLaunchWorkspace(target) : target.workspace
  const preferences = ensureAgentLaunchPreferences(store, workspace)
  const [agentOverride, agentLaunchPreferences] = await Promise.all([
    resolveSavedAgentOverride(recipe, repo, workspace, preferences, messages),
    preferences
  ])
  const prompt = agentOverride.kind === 'blocked' ? '' : args.renderPrompt()
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
