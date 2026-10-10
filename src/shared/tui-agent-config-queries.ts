import type { TuiAgent } from './tui-agent'
import type { TuiAgentConfig } from './tui-agent-config-types'

import { TUI_AGENT_CONFIG } from './tui-agent-config'

/**
 * Read-side helpers over {@link TUI_AGENT_CONFIG}, split out of tui-agent-config.ts
 * so that file stays under the max-lines ratchet while agents gain entries
 * (re-exported from there for every existing importer).
 */

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
