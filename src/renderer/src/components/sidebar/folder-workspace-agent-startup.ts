import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import {
  resolveRepoExecutionHostPlatform,
  type ExecutionHostPlatformFact
} from '@/lib/execution-host-facts'
import type { AppState } from '@/store/types'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'

/** OS of the host that owns a folder group; its agents are quoted for that host's shell. */
export function getFolderWorkspaceAgentLaunchFact(
  state: Pick<
    AppState,
    'sshConnectionStates' | 'sshStateByEnvironment' | 'runtimeStatusByEnvironmentId'
  >,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId' | 'parentPath'>
): ExecutionHostPlatformFact {
  return resolveRepoExecutionHostPlatform(
    state,
    {
      connectionId: projectGroup.connectionId,
      executionHostId: projectGroup.executionHostId,
      path: projectGroup.parentPath?.trim() ?? ''
    },
    () => undefined
  )
}

/** Resolve the linked context that should appear in the agent input without submitting. */
export function resolveFolderWorkspaceLaunchDraft(
  linkedWorkItem: LinkedWorkItemSummary,
  note: string
): string | null {
  const { prompt, draftPrompt } = resolveQuickCreateLinkedWorkItemPrompt(linkedWorkItem, note)
  return (draftPrompt ?? prompt.trim()) || null
}

export function buildFolderWorkspaceLinkedStartupPlan(args: {
  agent: TuiAgent
  linkedWorkItem: LinkedWorkItemSummary
  note: string
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote: boolean
}): AgentStartupPlan | null {
  const linkedDraftPrompt = resolveFolderWorkspaceLaunchDraft(args.linkedWorkItem, args.note)
  const draftLaunchPlan = linkedDraftPrompt
    ? buildAgentDraftLaunchPlan({
        agent: args.agent,
        draft: linkedDraftPrompt,
        cmdOverrides: args.agentCmdOverrides ?? {},
        agentArgs: args.agentArgs,
        agentEnv: args.agentEnv,
        platform: args.platform,
        shell: args.shell,
        isRemote: args.isRemote
      })
    : null
  if (draftLaunchPlan) {
    return {
      agent: draftLaunchPlan.agent,
      launchCommand: draftLaunchPlan.launchCommand,
      expectedProcess: draftLaunchPlan.expectedProcess,
      followupPrompt: null,
      launchConfig: draftLaunchPlan.launchConfig,
      ...(draftLaunchPlan.startupCommandDelivery
        ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
        : {}),
      ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
    }
  }

  const startupPlan = buildAgentStartupPlan({
    agent: args.agent,
    // Why: linked context must stay reviewable; launch empty, then paste the draft after readiness.
    prompt: '',
    cmdOverrides: args.agentCmdOverrides ?? {},
    agentArgs: args.agentArgs,
    agentEnv: args.agentEnv,
    platform: args.platform,
    shell: args.shell,
    isRemote: args.isRemote,
    allowEmptyPromptLaunch: true
  })
  if (startupPlan && linkedDraftPrompt) {
    startupPlan.draftPrompt = linkedDraftPrompt
  }
  return startupPlan
}
