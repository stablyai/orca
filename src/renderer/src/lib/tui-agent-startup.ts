import {
  buildAgentResumeStartupPlan as buildAgentResumeStartupPlanShared,
  buildAgentDraftLaunchPlan as buildAgentDraftLaunchPlanShared,
  buildAgentStartupPlan as buildAgentStartupPlanShared,
  planAgentCliArgsSuffix,
  isShellProcess,
  quoteStartupArg,
  resolveSessionRulesDeliveryShell,
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup'
import {
  resolveEffectiveAgentSessionRules,
  serializeAgentSessionRulesForInjection
} from '../../../shared/agent-session-rules'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  buildAgentSessionRulesOnlyDraft,
  hasNativeSessionRulesInjection,
  prependSessionRulesToPrompt
} from '../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../shared/types'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

export type {
  AgentCliArgsPlan,
  AgentDraftLaunchPlan,
  AgentStartupPlan
} from '../../../shared/tui-agent-startup'

export { planAgentCliArgsSuffix, isShellProcess, quoteStartupArg, resolveStartupShell }

/** Identifies the repo/host a launch targets so rules use the right repository override. */
export type AgentSessionRulesLaunchContext = {
  /** null/omitted for folder workspaces or launches that precede a repo record. */
  repoId?: string | null
  /** Explicit host override for pre-repo-creation launches; otherwise derived from repoId. */
  connectionId?: string | null
  /** Exact owner when local and runtime repos share an id without an SSH connection. */
  executionHostId?: ExecutionHostId | null
}

function resolveAgentSessionRulesText(context: AgentSessionRulesLaunchContext): string | null {
  const { settings, repos } = useAppStore.getState()
  if (!settings) {
    return null
  }
  const connectionId = context.connectionId?.trim() || null
  const repoCandidates = context.repoId
    ? repos.filter(
        (candidate) =>
          candidate.id === context.repoId &&
          (candidate.connectionId?.trim() || null) === connectionId
      )
    : []
  const repo = context.executionHostId
    ? (repoCandidates.find(
        (candidate) => getRepoExecutionHostId(candidate) === context.executionHostId
      ) ?? null)
    : repoCandidates.length === 1
      ? repoCandidates[0]
      : null
  const rules = resolveEffectiveAgentSessionRules(
    settings.agentSessionRules,
    repo?.agentSessionRules
  )
  return serializeAgentSessionRulesForInjection(rules) || null
}

export function buildAgentSessionRulesPrompt(args: {
  agent: TuiAgent
  prompt: string
  shell?: AgentStartupShell
  repoId?: string | null
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}): string {
  const rulesText = resolveAgentSessionRulesText(args)
  if (
    !rulesText ||
    !args.prompt.trim() ||
    hasNativeSessionRulesInjection(TUI_AGENT_CONFIG[args.agent], null, rulesText, args.shell)
  ) {
    return args.prompt
  }
  return prependSessionRulesToPrompt(args.prompt, rulesText)
}

export function buildAgentSessionRulesInputDraft(
  args: { agent: TuiAgent; shell?: AgentStartupShell } & AgentSessionRulesLaunchContext
): string | null {
  return buildAgentSessionRulesOnlyDraft(
    TUI_AGENT_CONFIG[args.agent],
    null,
    resolveAgentSessionRulesText(args),
    args.shell ?? 'posix'
  )
}

export function buildAgentStartupPlan(
  args: Parameters<typeof buildAgentStartupPlanShared>[0] & AgentSessionRulesLaunchContext
): ReturnType<typeof buildAgentStartupPlanShared> {
  const { repoId, connectionId, executionHostId, ...sharedArgs } = args
  const agentSessionRulesText = resolveAgentSessionRulesText({
    repoId,
    connectionId,
    executionHostId
  })
  return buildAgentStartupPlanShared({ ...sharedArgs, agentSessionRulesText })
}

export function buildAgentResumeStartupPlan(
  args: Parameters<typeof buildAgentResumeStartupPlanShared>[0] & AgentSessionRulesLaunchContext
): ReturnType<typeof buildAgentResumeStartupPlanShared> {
  const { repoId, connectionId, executionHostId, ...sharedArgs } = args
  const agentSessionRulesText = resolveAgentSessionRulesText({
    repoId,
    connectionId,
    executionHostId
  })
  const plan = buildAgentResumeStartupPlanShared({ ...sharedArgs, agentSessionRulesText })
  const shell = resolveSessionRulesDeliveryShell(args)
  if (
    !plan ||
    !agentSessionRulesText ||
    hasNativeSessionRulesInjection(TUI_AGENT_CONFIG[args.agent], null, agentSessionRulesText, shell)
  ) {
    return plan
  }
  return {
    ...plan,
    draftPrompt: prependSessionRulesToPrompt('', agentSessionRulesText)
  }
}

export function buildAgentDraftLaunchPlan(
  args: Parameters<typeof buildAgentDraftLaunchPlanShared>[0] & AgentSessionRulesLaunchContext
): ReturnType<typeof buildAgentDraftLaunchPlanShared> {
  const { repoId, connectionId, executionHostId, ...sharedArgs } = args
  const agentSessionRulesText = resolveAgentSessionRulesText({
    repoId,
    connectionId,
    executionHostId
  })
  return buildAgentDraftLaunchPlanShared({ ...sharedArgs, agentSessionRulesText })
}
