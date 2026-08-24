import type { TuiAgent } from './tui-agent'

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

import { TUI_AGENT_CONFIG } from './tui-agent-config-table'

// Re-export: the launch table moved to its own module; every existing importer of
// `TUI_AGENT_CONFIG` from this path keeps working unchanged.
export { TUI_AGENT_CONFIG }

export function isTuiAgent(value: unknown): value is TuiAgent {
  return typeof value === 'string' && Object.hasOwn(TUI_AGENT_CONFIG, value)
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
