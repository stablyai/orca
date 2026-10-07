import type { GlobalSettings } from './global-settings-types'
import type { SessionOptionValue } from './native-chat-session-options'
import type { TuiAgent } from './tui-agent'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

/** The settings slice a launch reads; hosts pass their whole `GlobalSettings` row. */
export type AgentStartupSettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentCmdOverrides'
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentPermissionMode'
    | 'agentPermissionModeOverrides'
    | 'terminalWindowsShell'
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
  /** Launch-ready args for this launch (a client already applied its permission mode); `null` is
   *  "no arguments at all". Omit it to compose from this host's settings. */
  agentArgs?: string | null
  /** A requested shell is the one this PTY will be, so it owns the quoting family. */
  windowsShellOverride?: string | null
  sessionOptions?: Record<string, SessionOptionValue> | undefined
}): AgentStartupPlanInputs {
  const { agent, settings, platform, isRemote, sessionOptions } = args
  const shell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: args.windowsShellOverride ?? settings.terminalWindowsShell
  })
  return {
    agent,
    cmdOverrides: settings.agentCmdOverrides ?? {},
    // A per-launch override wins over the Settings default; `null` is "no arguments", so this
    // tests for absence rather than falsiness.
    agentArgs:
      args.agentArgs !== undefined
        ? args.agentArgs
        : resolveTuiAgentLaunchArgs(agent, settings, { platform, shell }),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings),
    platform,
    shell,
    isRemote,
    ...(sessionOptions ? { sessionOptions } : {}),
    // Why: session options are an explicit per-launch pick, so they outrank configured args —
    // without this the two spellings of the same flag both reach argv and the last one wins.
    sessionOptionsOverrideAgentArgs: Boolean(sessionOptions)
  }
}
