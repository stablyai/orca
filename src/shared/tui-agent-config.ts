import { TUI_AGENT_CONFIG } from './built-in-tui-agent-configs'
import type { BuiltInTuiAgent, TuiAgent } from './tui-agent'

export type AgentPromptInjectionMode =
  | 'argv'
  | 'flag-prompt'
  | 'flag-prompt-interactive'
  | 'flag-interactive'
  | 'hermes-query'
  | 'stdin-after-start'

export type DraftPasteReadySignal =
  | 'render-quiet-after-bracketed-paste'
  | 'codex-composer-prompt'
  | 'render-cursor-after-bracketed-paste'
  | 'grok-composer-prompt'

export type TuiAgentDetectionRuntime = NodeJS.Platform | 'wsl'

export type TuiAgentConfig = {
  detectCmd: string
  /** Additional executable names that identify the same agent on PATH. */
  detectCmdAliases?: readonly string[]
  /** Other commands that must also be present before this agent counts as installed. */
  detectRequiredCommands?: readonly string[]
  /** Detection runtimes where this launch mode is not available as a detected agent. */
  detectUnsupportedRuntimes?: readonly TuiAgentDetectionRuntime[]
  launchCmd: string
  /** Structured executable argv for integrations that must avoid shell reparsing. */
  launchArgv?: readonly [string, ...string[]]
  launchArgvByPlatform?: Partial<Record<NodeJS.Platform, readonly [string, ...string[]]>>
  /** Platform-specific launch command when the public binary name differs. */
  launchCmdByPlatform?: Partial<Record<NodeJS.Platform, string>>
  expectedProcess: string
  promptInjectionMode: AgentPromptInjectionMode
  /** Option terminator required before positional prompts that may look like CLI syntax. */
  argvPromptSeparator?: '--'
  /** Native CLI flag that seeds the input without submitting (e.g. Claude's `--prefill <text>`); preferred over the paste-after-ready path. */
  draftPromptFlag?: string
  /** Startup env var that seeds the input without submitting, for agents with no `--prefill`-style flag (e.g. pi); avoids the paste-after-ready race. */
  draftPromptEnvVar?: string
  /** Pre-write a trust artifact so the agent's first-launch "trust this folder?" menu doesn't consume the bracketed paste (see agent-trust-presets.ts). */
  preflightTrust?: 'cursor' | 'copilot' | 'codex'
  /** Agent-specific signal that the composer is ready for paste, stronger than the default quiet-render window. */
  draftPasteReadySignal?: DraftPasteReadySignal
  /** Hard deadline for the agent's composer readiness signal. */
  draftPasteReadyTimeoutMs?: number
  /** Windows Shift+Enter encoding override; omitted agents keep the legacy Esc+CR path. */
  windowsShiftEnterEncoding?: 'csi-u'
  /** Paste newlines for TUIs that read Windows console input records instead of VT paste frames. */
  windowsInputRecordPasteNewline?: 'alt-enter' | 'csi-u'
  /** Ctrl+Enter encoding for agents that consume CSI-u without active kitty flags. */
  ctrlEnterEncoding?: 'csi-u'
}

export { TUI_AGENT_CONFIG }

export function isTuiAgent(value: unknown): value is TuiAgent {
  return isBuiltInTuiAgent(value) || isWellFormedCustomTuiAgentId(value)
}

export function isBuiltInTuiAgent(value: unknown): value is BuiltInTuiAgent {
  return typeof value === 'string' && Object.hasOwn(TUI_AGENT_CONFIG, value)
}

export function isWellFormedCustomTuiAgentId(
  value: unknown
): value is `custom-agent:${BuiltInTuiAgent}:${string}` {
  if (typeof value !== 'string') {
    return false
  }
  const match =
    /^custom-agent:([^:]+):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      value
    )
  return Boolean(match && isBuiltInTuiAgent(match[1]))
}

export function getTuiAgentDetectCommands(config: TuiAgentConfig): string[] {
  return [config.detectCmd, ...(config.detectCmdAliases ?? [])]
}

export function getTuiAgentLaunchCommand(
  config: TuiAgentConfig,
  platform: NodeJS.Platform,
  opts?: { isRemote?: boolean }
): string {
  // Why: local-only orca-ide rename (avoids GNOME Orca clash) must not leak to Linux remotes, whose relay shim is always `orca`.
  if (opts?.isRemote && platform === 'linux') {
    return config.launchCmd
  }
  return config.launchCmdByPlatform?.[platform] ?? config.launchCmd
}

export function getTuiAgentLaunchArgv(
  config: TuiAgentConfig,
  platform: NodeJS.Platform,
  opts?: { isRemote?: boolean }
): string[] {
  const argv =
    opts?.isRemote && platform === 'linux'
      ? config.launchArgv
      : (config.launchArgvByPlatform?.[platform] ?? config.launchArgv)
  // Why: agents with no argv entry fall back to the launch command, which must apply the
  // same remote-linux orca-ide guard — the relay shim is always installed as `orca`.
  return argv ? [...argv] : getTuiAgentLaunchCommand(config, platform, opts).split(/\s+/)
}
