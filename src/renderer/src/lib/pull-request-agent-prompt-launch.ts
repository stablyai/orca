import { toast } from 'sonner'
import {
  ensureDetectedAgentsForRepo,
  ensureDetectedAgentsForWorktree,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import { pickSourceControlLaunchAgent } from '../../../shared/source-control-launch-agent-selection'
import { resolveRepoWorktreeLaunchPlatform } from '@/lib/execution-host-facts'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'

/** Caller-specific wording, so each entry point names what the user acted on. */
export type PullRequestAgentPromptLaunchMessages = {
  savedAgentUnavailable: () => string
  workspaceMissing: () => string
  workspaceRevealFailed: () => string
  noWorkspace: () => string
}

export type PullRequestAgentPromptLaunchArgs = {
  repoId: string
  commandInput: string
  savedAgentId: TuiAgent | null
  agentArgs?: string
  item?: GitHubWorkItem
  worktreeId?: string | null
  groupId?: string | null
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  openModalFallback?: () => void
  messages: PullRequestAgentPromptLaunchMessages
}

type SavedAgentOverrideResult =
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'launch-default' }
  | { kind: 'blocked' }

function isAgentAvailable(agent: TuiAgent, detectedAgents: TuiAgent[]): boolean {
  return (
    detectedAgents.includes(agent) &&
    isTuiAgentEnabled(agent, useAppStore.getState().settings?.disabledTuiAgents)
  )
}

function toastNoEnabledAgent(): void {
  toast.error(
    translate(
      'auto.lib.fix.checks.agent.launch.2ebf794906',
      'No enabled AI agent was detected on this workspace host.'
    )
  )
}

async function resolveSavedAgentOverride(
  savedAgent: TuiAgent | null,
  repo: RepoHostFields | null,
  messages: PullRequestAgentPromptLaunchMessages
): Promise<SavedAgentOverrideResult> {
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  const settings = useAppStore.getState().settings
  if (!savedAgent) {
    // Why: a paired server answers per workspace, so its default is resolved after creation.
    if (!pendingAgents) {
      return { kind: 'launch-default' }
    }
    // Why: same pick as an existing workspace, so a prompt is never dropped for want of an agent.
    const agent = pickSourceControlLaunchAgent({
      defaultAgent: settings?.defaultTuiAgent,
      detectedAgents: await pendingAgents,
      disabledAgents: settings?.disabledTuiAgents
    })
    if (!agent) {
      toastNoEnabledAgent()
      return { kind: 'blocked' }
    }
    return { kind: 'agent', agent }
  }
  // Why: a paired server answers per workspace, so only the enabled check can run before it exists;
  // the direct launch checks installation on the new workspace.
  const available = pendingAgents
    ? isAgentAvailable(savedAgent, await pendingAgents)
    : isTuiAgentEnabled(savedAgent, settings?.disabledTuiAgents)
  if (!available) {
    toast.error(messages.savedAgentUnavailable())
    return { kind: 'blocked' }
  }
  return { kind: 'agent', agent: savedAgent }
}

async function pickExistingWorktreeAgent(
  worktreeId: string,
  savedAgent: TuiAgent | null,
  messages: PullRequestAgentPromptLaunchMessages
): Promise<TuiAgent | null> {
  const detectedAgents = await ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId)
  if (savedAgent) {
    if (isAgentAvailable(savedAgent, detectedAgents)) {
      return savedAgent
    }
    toast.error(messages.savedAgentUnavailable())
    return null
  }
  const settings = useAppStore.getState().settings
  const agent = pickSourceControlLaunchAgent({
    defaultAgent: settings?.defaultTuiAgent,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents
  })
  if (!agent) {
    toastNoEnabledAgent()
  }
  return agent
}

/**
 * Starts an agent for a pull request and submits `commandInput` once it is ready: in the
 * requested or PR-attached workspace when there is one, otherwise in a new workspace for the PR.
 */
export async function launchPullRequestAgentPrompt(
  args: PullRequestAgentPromptLaunchArgs
): Promise<boolean> {
  const { messages } = args
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
    const agent = await pickExistingWorktreeAgent(targetWorktreeId, args.savedAgentId, messages)
    if (!agent) {
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
    const agentArgsPlan = planAgentCliArgsSuffix(
      args.agentArgs,
      launchPlatform === 'win32' ? 'powershell' : 'posix'
    )
    if (!agentArgsPlan.ok) {
      toast.error(agentArgsPlan.error)
      return false
    }
    let revealFailed = false
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: targetWorktreeId,
      groupId: args.groupId ?? targetWorktreeId,
      prompt: args.commandInput,
      agentArgs: args.agentArgs,
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

  const agentOverride = await resolveSavedAgentOverride(args.savedAgentId, repo, messages)
  if (agentOverride.kind === 'blocked') {
    return false
  }

  return await launchWorkItemDirect({
    item: { ...args.item, pasteContent: args.commandInput },
    repoId: args.repoId,
    launchSource: args.launchSource,
    telemetrySource: args.telemetrySource,
    promptDelivery: 'submit-after-ready',
    agentArgs: args.agentArgs,
    ...(agentOverride.kind === 'agent' ? { agentOverride: agentOverride.agent } : {}),
    openModalFallback: args.openModalFallback
  })
}
