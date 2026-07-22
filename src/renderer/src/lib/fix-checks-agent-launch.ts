import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '@/lib/source-control-launch-agent-selection'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from '../../../shared/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type {
  GitHubWorkItem,
  TuiAgent,
  WorkspaceCreateTelemetrySource
} from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRuntimeWorkItemLaunchContext } from '@/lib/work-item-runtime-host'

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

type AgentDetectionTarget = {
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  worktreeId?: string | null
}

async function detectAgentsForTarget(target: AgentDetectionTarget): Promise<TuiAgent[]> {
  const store = useAppStore.getState()
  const host = parseExecutionHostId(target.executionHostId)
  if (host?.kind === 'runtime') {
    return await store.ensureRuntimeDetectedAgents(host.environmentId)
  }
  const connectionId = host?.kind === 'ssh' ? host.targetId : target.connectionId
  return typeof connectionId === 'string'
    ? await store.ensureRemoteDetectedAgents(connectionId)
    : await store.ensureDetectedAgents(
        target.worktreeId ? { worktreeId: target.worktreeId } : undefined
      )
}

function isAgentAvailable(agent: TuiAgent, detectedAgents: TuiAgent[]): boolean {
  return (
    detectedAgents.includes(agent) &&
    isTuiAgentEnabled(agent, useAppStore.getState().settings?.disabledTuiAgents)
  )
}

async function resolveSavedAgentOverride(
  savedAgent: TuiAgent | null | undefined,
  target: AgentDetectionTarget
): Promise<SavedAgentOverrideResult> {
  if (!savedAgent) {
    return { kind: 'launch-default' }
  }
  const detectedAgents = await detectAgentsForTarget(target)
  if (!isAgentAvailable(savedAgent, detectedAgents)) {
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
  savedAgent: TuiAgent | null | undefined,
  connectionId: string | null,
  executionHostId: ExecutionHostId
): Promise<TuiAgent | null> {
  const detectedAgents = await detectAgentsForTarget({
    connectionId,
    executionHostId,
    worktreeId
  })
  if (savedAgent) {
    if (isAgentAvailable(savedAgent, detectedAgents)) {
      return savedAgent
    }
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.4c7f783a7a',
        'Saved checks agent is not available on this workspace host.'
      )
    )
    return null
  }
  const settings = useAppStore.getState().settings
  const agent = pickSourceControlLaunchAgent({
    defaultAgent: settings?.defaultTuiAgent,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents
  })
  if (!agent) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.2ebf794906',
        'No enabled AI agent was detected on this workspace host.'
      )
    )
  }
  return agent
}

export async function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const store = useAppStore.getState()
  const repo = findRepoForHost(store.repos, args.repoId, {
    hostId: args.item?.repoExecutionHostId,
    settings: store.settings
  })
  const recipe = resolveSourceControlActionRecipe({
    settings: store.settings,
    repo,
    actionId: 'fixChecks'
  })
  const savedAgentId = readSourceControlLaunchRecipeAgentId(recipe)
  const commandInput = renderSourceControlActionCommandTemplate(
    recipe.commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixChecks,
    { basePrompt: args.basePrompt }
  ).trim()
  if (!commandInput) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.9f00d7df0c',
        'Fix checks prompt is empty. Update Source Control AI settings.'
      )
    )
    return false
  }

  const allWorktrees = store.allWorktrees()
  const attachedWorkspace =
    args.worktreeId || !args.item
      ? null
      : findGithubPrWorkspaceAttachment(
          allWorktrees,
          args.repoId,
          args.item.number,
          args.item.repoExecutionHostId
        )
  const requestedWorktreeId = args.worktreeId ?? attachedWorkspace?.id ?? null
  if (requestedWorktreeId) {
    const matchingWorktrees = allWorktrees.filter((worktree) => worktree.id === requestedWorktreeId)
    // Why: activation, tabs, and terminal launch still use the legacy bare worktree id.
    // Fail closed until those store surfaces accept a composite host identity.
    if (matchingWorktrees.length !== 1) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.dfb4dd7c00',
          'Unable to find the workspace attached to these checks.'
        )
      )
      return false
    }
    const targetWorktree = attachedWorkspace ?? matchingWorktrees[0]
    const targetWorktreeId = targetWorktree.id
    const targetExecutionHostId = getWorktreeExecutionHostId(targetWorktree, repo ?? undefined)
    const targetHost = parseExecutionHostId(targetExecutionHostId)
    // Why: an explicit worktree host (even local) is authoritative, so stamped
    // worktrees must not fall back to legacy connection-id derivation.
    const targetConnectionId =
      targetHost?.kind === 'ssh'
        ? targetHost.targetId
        : targetHost?.kind === 'runtime' || targetWorktree.hostId
          ? null
          : (getConnectionId(targetWorktreeId) ?? repo?.connectionId ?? null)
    const agent = await pickExistingWorktreeAgent(
      targetWorktreeId,
      savedAgentId,
      targetConnectionId,
      targetExecutionHostId
    )
    if (!agent) {
      return false
    }
    const launchPlatform =
      getRuntimeWorkItemLaunchContext(store, targetExecutionHostId)?.platform ??
      resolveSourceControlLaunchPlatform({
        connectionId: targetConnectionId,
        worktreePath: targetWorktree.path,
        projectRuntime:
          targetConnectionId || targetHost?.kind === 'runtime'
            ? undefined
            : getLocalProjectExecutionRuntimeContext(store, targetWorktreeId, CLIENT_PLATFORM)
      })
    if (!launchPlatform) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.822bf52295',
          'Unable to resolve the workspace launch platform.'
        )
      )
      return false
    }
    const agentArgsPlan = planAgentCliArgsSuffix(
      recipe.agentArgs,
      launchPlatform === 'win32' ? 'powershell' : 'posix'
    )
    if (!agentArgsPlan.ok) {
      toast.error(agentArgsPlan.error)
      return false
    }
    if (!activateAndRevealWorktree(targetWorktreeId)) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.03c1d61f83',
          'Unable to open the workspace attached to these checks.'
        )
      )
      return false
    }
    const result = launchAgentInNewTab({
      agent,
      worktreeId: targetWorktreeId,
      groupId: args.groupId ?? targetWorktreeId,
      prompt: commandInput,
      agentArgs: recipe.agentArgs,
      promptDelivery: 'submit-after-ready',
      launchPlatform,
      launchSource: args.launchSource
    })
    if (!result) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.fb6c294e85',
          'Could not build the agent launch command.'
        )
      )
      return false
    }
    if (result.tabId) {
      focusTerminalTabSurface(result.tabId)
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

  const repoExecutionHostId = repo ? getRepoExecutionHostId(repo) : args.item.repoExecutionHostId
  const agentOverride = await resolveSavedAgentOverride(savedAgentId, {
    connectionId: repo?.connectionId,
    executionHostId: repoExecutionHostId
  })
  if (agentOverride.kind === 'blocked') {
    return false
  }

  return await launchWorkItemDirect({
    item: { ...args.item, pasteContent: commandInput },
    repoId: args.repoId,
    repoExecutionHostId,
    launchSource: args.launchSource,
    telemetrySource: args.telemetrySource,
    promptDelivery: 'submit-after-ready',
    agentArgs: recipe.agentArgs,
    ...(agentOverride.kind === 'agent' ? { agentOverride: agentOverride.agent } : {}),
    openModalFallback: args.openModalFallback
  })
}
