import {
  beginDesktopNavigation,
  canPresentDesktopNavigation,
  type DesktopNavigationRequest
} from './desktop-navigation'
import {
  ensureAgentLaunchPreferences,
  type AgentLaunchPreferences
} from '@/components/settings/use-host-agent-launch-preferences'
import {
  resolveChecksActionAgent,
  sourceControlRepoAgentRows,
  pickExistingWorktreeChecksAgent
} from '@/lib/source-control-agent-picker'
export { resolveChecksActionAgent } from '@/lib/source-control-agent-picker'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from './host-chat-program-acquisition'
import { toast } from 'sonner'
import {
  ensureDetectedAgentsForRepo,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { type ProspectiveWorkspace, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { readSourceControlLaunchRecipeAgentId } from '../../../shared/source-control-launch-agent-selection'
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
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import {
  projectSourceControlActionLaunch,
  resolveSourceControlActionRequestedSurface,
  resolveSourceControlActionSessionOptions,
  sourceControlActionAgentArgs
} from '../../../shared/source-control-action-launch-preferences'

type StartFixChecksAgentArgs = {
  navigation?: DesktopNavigationRequest
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

async function resolveSavedAgentOverride(
  savedAgentId: () => TuiAgent | null | undefined,
  repo: (RepoHostFields & { id: string }) | null,
  workspace: ProspectiveWorkspace,
  preferencesPromise: Promise<AgentLaunchPreferences>
): Promise<SavedAgentOverrideResult> {
  if (!savedAgentId()) {
    return { kind: 'launch-default' }
  }
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  // Why: a paired server answers per workspace, so only the enabled check can run before it exists;
  // the direct launch checks installation on the new workspace.
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
    ? resolveChecksActionAgent(current, 'fixChecks', repo?.id, workspace, detected, preferences) ===
      savedAgent
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

export function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const navigation = args.navigation ?? beginDesktopNavigation()
  return launchFixChecksAgent({ ...args, navigation }).catch((error) => {
    if (
      error instanceof AgentLaunchChoiceCancelled ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      return false
    }
    throw error
  })
}

async function launchFixChecksAgent(
  args: StartFixChecksAgentArgs & { navigation: DesktopNavigationRequest }
): Promise<boolean> {
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
    const agent = await pickExistingWorktreeChecksAgent(targetWorktreeId)
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
    const { commandInput: projectedPrompt, ...projection } = projectSourceControlActionLaunch(
      recipe(),
      agent,
      { renderedPrompt: prompt, settings: useAppStore.getState().settings }
    )
    let revealFailed = false
    const result = launchAgentInNewTab({
      navigation: args.navigation,
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: targetWorktreeId,
      groupId: args.groupId ?? targetWorktreeId,
      prompt: projectedPrompt,
      ...projection,
      promptDelivery: 'submit-after-ready',
      launchPlatform,
      launchSource: args.launchSource,
      beforeSurfaceOpen: (_surface, navigation) => {
        // Why: the launcher owns the initial surface, so revealing must not seed a sibling shell.
        const revealed = activateAndRevealWorktree(targetWorktreeId, {
          navigation,
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
    if (result.surface.kind === 'local-terminal' && canPresentDesktopNavigation(args.navigation)) {
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
    resolveSavedAgentOverride(savedAgentId, repo, workspace, preferences),
    preferences
  ])
  const prompt = agentOverride.kind === 'blocked' ? '' : commandInput()
  if (!prompt) {
    return false
  }

  return await launchWorkItemDirect({
    navigation: args.navigation,
    item: { ...args.item, pasteContent: prompt },
    repoId: args.repoId,
    agentLaunchPreferences,
    launchSource: args.launchSource,
    telemetrySource: args.telemetrySource,
    promptDelivery: 'submit-after-ready',
    agentArgs: recipe().agentArgs,
    resolveAgentArgs: (agent) =>
      sourceControlActionAgentArgs(recipe(), agent, useAppStore.getState().settings),
    resolveSessionOptions: (agent) => resolveSourceControlActionSessionOptions(recipe(), agent),
    ...(agentOverride.kind === 'agent'
      ? {
          agentOverride: agentOverride.agent,
          launchChoice: {
            requestedSurface: resolveSourceControlActionRequestedSurface(
              recipe(),
              agentOverride.agent
            )
          }
        }
      : {}),
    openModalFallback: args.openModalFallback
  })
}
