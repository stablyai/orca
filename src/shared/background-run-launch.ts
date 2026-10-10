/**
 * What a desktop automation's run spawns: its startup plan, its pane's environment and its PTY
 * spawn request. The window builds its own spawn with these and its host builds the same one for
 * `agent.launch`'s `backgroundRun`, so the two starts cannot drift apart.
 */

import { tuiAgentToAgentKind } from './agent-kind'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from './agent-startup-plan-inputs'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import { requireTuiAgentConfig } from './require-tui-agent-config'
import type { AgentKind, RequestKind } from './telemetry-events'
import type { TuiAgent } from './tui-agent'
import { buildAgentStartupPlan, type AgentStartupPlan } from './tui-agent-startup'
import { isWslUncPath } from './wsl-paths'

export type BackgroundRunStartup = {
  plan: AgentStartupPlan
  /** The prompt the launch command carries; absent for an agent that takes it after it starts. */
  commandPrompt?: string
  /** The prompt pasted once the agent is ready, for an agent that takes it after it starts. */
  pastePromptAfterStart: string | null
}

/** Null when the agent has no launch command; invalid extra arguments throw. */
export function buildBackgroundRunStartup(args: {
  agent: TuiAgent
  settings: AgentStartupSettings
  platform: NodeJS.Platform
  isRemote: boolean
  extraAgentArgs?: string
  prompt?: string
}): BackgroundRunStartup | null {
  const { agent } = args
  const planInputs = resolveAgentStartupPlanInputs({
    agent,
    settings: args.settings,
    platform: args.platform,
    isRemote: args.isRemote,
    extraAgentArgs: args.extraAgentArgs
  })
  const trimmedPrompt = args.prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = requireTuiAgentConfig(agent).promptInjectionMode === 'stdin-after-start'
  const commandPrompt = hasPrompt && !isFollowupPath ? trimmedPrompt : ''
  const plan = buildAgentStartupPlan({
    ...planInputs,
    prompt: commandPrompt,
    allowEmptyPromptLaunch: !hasPrompt || isFollowupPath
  })
  if (!plan) {
    return null
  }
  return {
    plan,
    ...(commandPrompt ? { commandPrompt } : {}),
    pastePromptAfterStart: hasPrompt && isFollowupPath ? trimmedPrompt : null
  }
}

export function backgroundRunPaneEnv(args: {
  env: Record<string, string> | undefined
  paneKey: string
  tabId: string
  worktreeId: string
  launchToken: string
}): Record<string, string> {
  return {
    ...args.env,
    ORCA_PANE_KEY: args.paneKey,
    ORCA_TAB_ID: args.tabId,
    ORCA_WORKTREE_ID: args.worktreeId,
    ORCA_AGENT_LAUNCH_TOKEN: args.launchToken
  }
}

export type BackgroundRunPtySpawn<LaunchSourceName extends string = string> = {
  cols: number
  rows: number
  cwd: string
  command: string
  shellOverride?: string
  commandDelivery?: 'provider'
  startupCommandDelivery?: StartupCommandDelivery
  env: Record<string, string>
  launchConfig: SleepingAgentLaunchConfig
  launchToken: string
  launchAgent: TuiAgent
  connectionId: string | null
  worktreeId: string
  tabId: string
  leafId: string
  placement: { kind: 'new-tab'; row?: { customTitle: string } }
  telemetry: {
    agent_kind: AgentKind
    launch_source: LaunchSourceName | 'unknown'
    request_kind: RequestKind
  }
}

export function buildBackgroundRunPtySpawn<LaunchSourceName extends string>(args: {
  agent: TuiAgent
  plan: AgentStartupPlan
  cwd: string
  worktreeId: string
  /** The SSH connection the workspace lives on; null on this machine. */
  sshConnectionId: string | null
  env: Record<string, string>
  launchToken: string
  tabId: string
  leafId: string
  title?: string
  launchSource?: LaunchSourceName
}): BackgroundRunPtySpawn<LaunchSourceName> {
  const { agent, plan, sshConnectionId, title } = args
  return {
    cols: 120,
    rows: 40,
    cwd: args.cwd,
    command: plan.launchCommand,
    ...(!sshConnectionId && isWslUncPath(args.cwd) ? { shellOverride: 'wsl.exe' } : {}),
    // Why: the relay types, waits for the shell and stages long lines on the host that owns the PTY.
    ...(sshConnectionId
      ? { commandDelivery: 'provider' as const, startupCommandDelivery: 'shell-ready' as const }
      : plan.startupCommandDelivery
        ? { startupCommandDelivery: plan.startupCommandDelivery }
        : {}),
    env: args.env,
    launchConfig: plan.launchConfig,
    launchToken: args.launchToken,
    launchAgent: agent,
    connectionId: sshConnectionId,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    // Why no launchAgent: the adopted tab is created without one, and the row must match it.
    placement: { kind: 'new-tab', ...(title ? { row: { customTitle: title } } : {}) },
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: args.launchSource ?? 'unknown',
      request_kind: 'new'
    }
  }
}
