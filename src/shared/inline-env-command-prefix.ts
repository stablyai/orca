// Env assignments for a command Orca TYPES into a shell it already owns, rather
// than one it spawns with an env map. The adopted-Codex return path has no spawn
// to attach env to: the pane is a live shell and the resume command is keystrokes.
import {
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export function buildInlineEnvCommandPrefix(args: {
  env: Record<string, string>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
}): string {
  const entries = Object.entries(args.env)
  if (entries.length === 0) {
    return ''
  }
  const shell = resolveStartupShell(args.platform, args.shell)
  const quote = (value: string): string => quoteStartupArg(value, shell)
  if (shell === 'powershell') {
    return `${entries.map(([name, value]) => `$env:${name}=${quote(value)}`).join('; ')}; `
  }
  if (shell === 'cmd') {
    // Why: `set` here outlives the command, unlike the POSIX one-shot form. Safe
    // because every caller overwrites the same names on its next invocation, so a
    // leftover value can only ever fail a match — never satisfy a fresh one.
    return `${entries.map(([name, value]) => `set ${quote(`${name}=${value}`)}`).join(' && ')} && `
  }
  // Why `env` rather than the bare `NAME=value cmd` prefix: fish rejects that form
  // outright ("Unsupported use of '='"), and the pane's POSIX dialect is not
  // recorded anywhere Orca can read at write time. `env` parses in sh, bash, zsh
  // and fish alike, and matches how every other Orca launch path reaches the agent
  // binary — through the executable, not a shell alias.
  return `env ${entries.map(([name, value]) => `${name}=${quote(value)}`).join(' ')} `
}

/** Prefixes a typed command so the assignments apply to that invocation. */
export function withInlineEnvAssignments(args: {
  command: string
  env: Record<string, string>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
}): string {
  return `${buildInlineEnvCommandPrefix(args)}${args.command}`
}
