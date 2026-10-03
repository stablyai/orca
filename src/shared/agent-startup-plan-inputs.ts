import type { GlobalSettings } from './global-settings-types'
import type { SessionOptionValue } from './native-chat-session-options'
import type { TuiAgent } from './tui-agent'
import { applyIncognitoLaunchFlag } from './tui-agent-incognito'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

/** The settings slice a launch reads; hosts pass their whole `GlobalSettings` row. */
export type AgentStartupSettings = Partial<
  Pick<
    GlobalSettings,
    'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv' | 'terminalWindowsShell'
  >
>

/** Exactly the `buildAgentStartupPlan` / `buildAgentDraftLaunchPlan` inputs that settings decide. */
export type AgentStartupPlanInputs = {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentArgs: string | null
  agentEnv: Record<string, string>
  platform: NodeJS.Platform
  shell: AgentStartupShell | undefined
  isRemote: boolean
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs: boolean
}

/**
 * Assembles the settings-derived half of a startup plan's inputs.
 *
 * `buildAgentStartupPlan` was already one shared implementation, but every host re-derived its
 * argument object by hand from the same four settings, and the copies had drifted — one dropped
 * `sessionOptionsOverrideAgentArgs` and so let configured `agentDefaultArgs` silently defeat an
 * explicit model pick. What varies between launches is the host (`platform`, `isRemote`), the
 * shell this PTY will actually be, and the per-launch overrides; those stay parameters. What does
 * not vary is how settings become inputs, which is this function.
 */
export function resolveAgentStartupPlanInputs(args: {
  agent: TuiAgent
  settings: AgentStartupSettings
  platform: NodeJS.Platform
  isRemote: boolean
  /** Replaces the configured default args for this launch; `null` is "no arguments". */
  agentArgs?: string | null
  /** A requested shell is the one this PTY will be, so it owns the quoting family. */
  windowsShellOverride?: string | null
  sessionOptions?: Record<string, SessionOptionValue> | undefined
  /** When true and the agent is incognito-capable, its native ephemeral flag is added to argv. */
  incognito?: boolean
}): AgentStartupPlanInputs {
  const { agent, settings, platform, isRemote, sessionOptions } = args
  // A per-launch override wins over the Settings default; `null` is "no arguments", so this tests
  // for absence rather than falsiness. Incognito then adds the harness's own ephemeral flag so the
  // agent — not just Orca's scrollback — is ephemeral (no-op for non-capable agents / a null arg).
  const resolvedAgentArgs =
    args.agentArgs !== undefined
      ? args.agentArgs
      : resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs)
  return {
    agent,
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs:
      resolvedAgentArgs === null
        ? applyIncognitoLaunchFlag(agent, '', args.incognito === true) || null
        : applyIncognitoLaunchFlag(agent, resolvedAgentArgs, args.incognito === true),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: args.windowsShellOverride ?? settings.terminalWindowsShell
    }),
    isRemote,
    ...(sessionOptions ? { sessionOptions } : {}),
    // Why: session options are an explicit per-launch pick, so they outrank configured args —
    // without this the two spellings of the same flag both reach argv and the last one wins.
    sessionOptionsOverrideAgentArgs: Boolean(sessionOptions)
  }
}
