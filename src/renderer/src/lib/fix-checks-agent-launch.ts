import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '@/lib/source-control-launch-agent-selection'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
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

async function detectAgentsForConnection(
  connectionId: string | null | undefined
): Promise<TuiAgent[]> {
  const store = useAppStore.getState()
  return typeof connectionId === 'string'
    ? await store.ensureRemoteDetectedAgents(connectionId)
    : await store.ensureDetectedAgents()
}

function isAgentAvailable(agent: TuiAgent, detectedAgents: TuiAgent[]): boolean {
  return (
    detectedAgents.includes(agent) &&
    isTuiAgentEnabled(agent, useAppStore.getState().settings?.disabledTuiAgents)
  )
}

async function resolveSavedAgentOverride(
  savedAgent: TuiAgent | null | undefined,
  connectionId: string | null | undefined
): Promise<SavedAgentOverrideResult> {
  if (!savedAgent) {
    return { kind: 'launch-default' }
  }
  const detectedAgents = await detectAgentsForConnection(connectionId)
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
  repoConnectionId: string | null | undefined
): Promise<TuiAgent | null> {
  const connectionId = getConnectionId(worktreeId) ?? repoConnectionId ?? null
  const detectedAgents = await detectAgentsForConnection(connectionId)
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
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
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

  const attachedWorkspace =
    args.worktreeId || !args.item
      ? null
      : findGithubPrWorkspaceAttachment(store.allWorktrees(), args.repoId, args.item.number)
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
    const targetConnectionId = getConnectionId(targetWorktreeId) ?? repo?.connectionId ?? null
    const agent = await pickExistingWorktreeAgent(
      targetWorktreeId,
      savedAgentId,
      repo?.connectionId
    )
    if (!agent) {
      return false
    }
    const launchPlatform = resolveSourceControlLaunchPlatform({
      connectionId: targetConnectionId,
      worktreePath: targetWorktree.path
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

  const agentOverride = await resolveSavedAgentOverride(savedAgentId, repo?.connectionId)
  if (agentOverride.kind === 'blocked') {
    return false
  }

  return await launchWorkItemDirect({
    item: { ...args.item, pasteContent: commandInput },
    repoId: args.repoId,
    launchSource: args.launchSource,
    telemetrySource: args.telemetrySource,
    promptDelivery: 'submit-after-ready',
    agentArgs: recipe.agentArgs,
    ...(agentOverride.kind === 'agent' ? { agentOverride: agentOverride.agent } : {}),
    openModalFallback: args.openModalFallback
  })
}
