import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from '../../../../shared/agent-startup-plan-inputs'
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

export function resolveFolderWorkspaceLaunchDraft(
  linkedWorkItem: LinkedWorkItemSummary,
  note: string
): string | null {
  const { prompt, draftPrompt } = resolveQuickCreateLinkedWorkItemPrompt(linkedWorkItem, note)
  return (draftPrompt ?? prompt.trim()) || null
}

export function buildFolderWorkspaceLinkedStartupPlan(args: {
  agent: TuiAgent
  settings?: AgentStartupSettings
  linkedWorkItem: LinkedWorkItemSummary
  note: string
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote: boolean
}): AgentStartupPlan | null {
  const inputs = resolveAgentStartupPlanInputs({
    agent: args.agent,
    settings: args.settings ?? { agentCmdOverrides: args.agentCmdOverrides },
    agentArgs: args.settings ? args.agentArgs : (args.agentArgs ?? null),
    platform: args.platform,
    shell: args.shell,
    isRemote: args.isRemote
  })
  if (args.agentEnv) {
    inputs.agentEnv = args.agentEnv
  }
  const linkedDraftPrompt = resolveFolderWorkspaceLaunchDraft(args.linkedWorkItem, args.note)
  const draftLaunchPlan = linkedDraftPrompt
    ? buildAgentDraftLaunchPlan({
        ...inputs,
        draft: linkedDraftPrompt
      })
    : null
  if (draftLaunchPlan) {
    return {
      agent: draftLaunchPlan.agent,
      launchCommand: draftLaunchPlan.launchCommand,
      expectedProcess: draftLaunchPlan.expectedProcess,
      followupPrompt: null,
      launchConfig: draftLaunchPlan.launchConfig,
      ...(draftLaunchPlan.sessionOptions ? { sessionOptions: draftLaunchPlan.sessionOptions } : {}),
      ...(draftLaunchPlan.startupCommandDelivery
        ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
        : {}),
      ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
    }
  }

  const startupPlan = buildAgentStartupPlan({
    ...inputs,
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  if (startupPlan && linkedDraftPrompt) {
    startupPlan.draftPrompt = linkedDraftPrompt
  }
  return startupPlan
}
