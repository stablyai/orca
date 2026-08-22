// Why: the linked-workspace launch plan is its own decision — which of the two
// startup shapes a linked work item gets — and it needs room to grow alongside
// the agent launch contract without pushing the submit flow over its size cap.

import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStatusHookSettings } from '../../../../shared/agent-status-hooks-for-agent'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'

/**
 * The launch context a linked folder-workspace agent starts with in its TUI
 * input but never submits — delivered as argv prefill or a startup paste
 * depending on the agent.
 */
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
  sessionOptions?: Record<string, SessionOptionValue>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote: boolean
  /** Settings that decide Orca's managed status hooks; the builder derives
   *  the per-agent answer itself (#11941). */
  agentStatusHookSettings: AgentStatusHookSettings | null
}): AgentStartupPlan | null {
  const linkedDraftPrompt = resolveFolderWorkspaceLaunchDraft(args.linkedWorkItem, args.note)
  const draftLaunchPlan = linkedDraftPrompt
    ? buildAgentDraftLaunchPlan({
        agent: args.agent,
        draft: linkedDraftPrompt,
        cmdOverrides: args.agentCmdOverrides ?? {},
        agentArgs: args.agentArgs,
        agentEnv: args.agentEnv,
        sessionOptions: args.sessionOptions,
        platform: args.platform,
        shell: args.shell,
        isRemote: args.isRemote,
        agentStatusHookSettings: args.agentStatusHookSettings
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
    agent: args.agent,
    // Why: linked context must stay reviewable; launch empty, then paste the
    // draft after the agent is ready instead of submitting it on argv/stdin.
    prompt: '',
    cmdOverrides: args.agentCmdOverrides ?? {},
    agentArgs: args.agentArgs,
    agentEnv: args.agentEnv,
    sessionOptions: args.sessionOptions,
    platform: args.platform,
    shell: args.shell,
    isRemote: args.isRemote,
    agentStatusHookSettings: args.agentStatusHookSettings,
    allowEmptyPromptLaunch: true
  })
  if (startupPlan && linkedDraftPrompt) {
    startupPlan.draftPrompt = linkedDraftPrompt
  }
  return startupPlan
}
