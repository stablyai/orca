// Exact function from660243e61ff:agent-startup-plan-inputs.ts; only export/import paths differ.
// Full-source SHA256573ec1fd98d1859f983e625cd593a1e636a53eb67e43871168e0bfc14e84130c.
import type { AgentStartupSettings, AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import type { SessionOptionValue } from './native-chat/input/native-chat-session-options'
import type { TuiAgent } from './tui-agent'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { hasExtraAgentArgs, mergeExtraAgentArgs } from './automation-extra-agent-args'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

export function resolveBaselineAgentStartupPlanInputs(args: {
  agent: TuiAgent
  settings: AgentStartupSettings
  platform: NodeJS.Platform
  isRemote: boolean
  /** Replaces the configured default args for this launch; `null` is "no arguments". */
  agentArgs?: string | null
  /** An automation's saved extras, merged over the resolved args; invalid extras throw. */
  extraAgentArgs?: string
  /** Pass the actual PTY shell; omission is valid only when the Settings shell is what the PTY receives. */
  shell: AgentStartupShell | undefined
  sessionOptions?: Record<string, SessionOptionValue> | undefined
  /** Orca types into this launch after start (worker, automation, handoff), not a user. */
  suppressStartupUpdatePrompt?: boolean
}): AgentStartupPlanInputs {
  const { agent, settings, platform, isRemote, sessionOptions } = args
  // Test absence: launch overrides win and null explicitly means no arguments.
  let agentArgs =
    args.agentArgs !== undefined ? args.agentArgs : resolveTuiAgentLaunchArgs(agent, settings)
  const shell =
    args.shell ??
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
  if (hasExtraAgentArgs(args.extraAgentArgs)) {
    const merged = mergeExtraAgentArgs({
      agent,
      defaultArgs: agentArgs,
      extraAgentArgs: args.extraAgentArgs,
      shell: resolveStartupShell(platform, shell)
    })
    if (!merged.ok) {
      throw new Error(merged.error)
    }
    agentArgs = merged.agentArgs
  }
  return {
    agent,
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs,
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings, platform),
    platform,
    shell,
    isRemote,
    ...(sessionOptions ? { sessionOptions } : {}),
    // Explicit session picks outrank configured args; duplicate flag spellings would otherwise let argv order decide.
    sessionOptionsOverrideAgentArgs: Boolean(sessionOptions),
    ...(args.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {})
  }
}
