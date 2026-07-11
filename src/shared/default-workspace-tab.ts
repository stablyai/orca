import type { TuiAgent } from './types'
import { isTuiAgent } from './tui-agent-config'
import type { BuiltInWindowsTerminalShell } from './windows-terminal-shell'
import { WINDOWS_GIT_BASH_SHELL } from './windows-terminal-shell'

/**
 * The surface Orca opens when a workspace is first activated from the sidebar
 * and has no existing tab. Mirrors the concrete choices in the "+" new-tab menu
 * so the configurable default stays in sync with what a user can create by hand.
 * `terminal` preserves the historical behavior and is the default; document
 * actions (New/Open Markdown) are intentionally excluded because they are
 * one-shot file operations, not a surface to reopen a workspace into.
 */
export type DefaultWorkspaceTab =
  | { kind: 'terminal' }
  | { kind: 'terminal-shell'; shell: BuiltInWindowsTerminalShell }
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'browser' }

// Why: frozen + copied at every hand-off (like the other object/array defaults
// in getDefaultSettings) so a shared reference can never be mutated in place and
// corrupt the default for other callers/profiles.
export const DEFAULT_WORKSPACE_TAB: Readonly<DefaultWorkspaceTab> = { kind: 'terminal' }

const BUILT_IN_WINDOWS_SHELLS: readonly BuiltInWindowsTerminalShell[] = [
  'powershell.exe',
  'cmd.exe',
  'wsl.exe',
  WINDOWS_GIT_BASH_SHELL
]

function isBuiltInWindowsTerminalShell(value: unknown): value is BuiltInWindowsTerminalShell {
  return (
    typeof value === 'string' &&
    BUILT_IN_WINDOWS_SHELLS.includes(value as BuiltInWindowsTerminalShell)
  )
}

/**
 * Coerces a persisted (and therefore untrusted) settings value into a valid
 * descriptor, falling back to a plain terminal for anything unrecognized — e.g.
 * a shell or agent id dropped in a later version. Whether the surface is
 * actually creatable on the current host (SSH/remote/platform) is a separate
 * runtime concern resolved at activation time.
 */
export function normalizeDefaultWorkspaceTab(value: unknown): DefaultWorkspaceTab {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_WORKSPACE_TAB }
  }
  const kind = (value as { kind?: unknown }).kind
  switch (kind) {
    case 'terminal':
      return { kind: 'terminal' }
    case 'browser':
      return { kind: 'browser' }
    case 'terminal-shell': {
      const shell = (value as { shell?: unknown }).shell
      return isBuiltInWindowsTerminalShell(shell)
        ? { kind: 'terminal-shell', shell }
        : { ...DEFAULT_WORKSPACE_TAB }
    }
    case 'agent': {
      const agent = (value as { agent?: unknown }).agent
      return isTuiAgent(agent) ? { kind: 'agent', agent } : { ...DEFAULT_WORKSPACE_TAB }
    }
    default:
      return { ...DEFAULT_WORKSPACE_TAB }
  }
}

const TERMINAL_SHELL_PREFIX = 'terminal-shell:'
const AGENT_PREFIX = 'agent:'

/**
 * Stable string id for a descriptor, used as the value of the settings
 * `<Select>`. Round-trips through {@link parseDefaultWorkspaceTab}.
 */
export function serializeDefaultWorkspaceTab(tab: DefaultWorkspaceTab): string {
  switch (tab.kind) {
    case 'terminal':
      return 'terminal'
    case 'browser':
      return 'browser'
    case 'terminal-shell':
      return `${TERMINAL_SHELL_PREFIX}${tab.shell}`
    case 'agent':
      return `${AGENT_PREFIX}${tab.agent}`
  }
}

/** Inverse of {@link serializeDefaultWorkspaceTab}; invalid input → terminal. */
export function parseDefaultWorkspaceTab(value: string): DefaultWorkspaceTab {
  if (value.startsWith(TERMINAL_SHELL_PREFIX)) {
    return normalizeDefaultWorkspaceTab({
      kind: 'terminal-shell',
      shell: value.slice(TERMINAL_SHELL_PREFIX.length)
    })
  }
  if (value.startsWith(AGENT_PREFIX)) {
    return normalizeDefaultWorkspaceTab({ kind: 'agent', agent: value.slice(AGENT_PREFIX.length) })
  }
  return normalizeDefaultWorkspaceTab({ kind: value })
}
