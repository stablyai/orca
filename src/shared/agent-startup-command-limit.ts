// Hard per-shell ceiling for a startup command line. The host resolver caps the
// RESOLVED argv before admission, but the prompt/resume suffixes are appended
// later during plan assembly, so the final command must be measured again with
// the same rule. Over the ceiling nothing can deliver the command — cmd.exe and
// the PowerShell -EncodedCommand argument are truncated by the OS, and the POSIX
// startup writer has its own byte budget — so callers must fail or move text off
// argv instead of emitting it.

import { buildShellCommandFromArgv, type AgentStartupShell } from './tui-agent-startup-shell'
import { utf8ByteLength } from './custom-tui-agent-fields'

/** Mirrors CMD_EXE_COMMAND_LINE_MAX_CHARS / POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS
 *  in main/providers/windows-shell-args.ts and POSIX_STARTUP_COMMAND_MAX_BYTES in
 *  main/agent-launch/compose-agent-launch-env.ts; declared here so the main-free
 *  shared plan builder can enforce the same ceiling. */
const CMD_COMMAND_LINE_MAX_CHARS = 8191
const POWERSHELL_ENCODED_COMMAND_MAX_CHARS = 28_000
const POSIX_COMMAND_MAX_BYTES = 131_072

/** PowerShell -EncodedCommand is base64 of the UTF-16LE command, so the OS
 *  argument ceiling applies to the encoded length, not the source text. */
function powerShellEncodedLength(commandText: string): number {
  return Math.ceil((commandText.length * 2) / 3) * 4
}

/** True when the final command text cannot be delivered to the target shell. */
export function startupCommandExceedsShellLimit(
  commandText: string,
  shell: AgentStartupShell
): boolean {
  if (shell === 'cmd') {
    return commandText.length > CMD_COMMAND_LINE_MAX_CHARS
  }
  if (shell === 'powershell') {
    return powerShellEncodedLength(commandText) > POWERSHELL_ENCODED_COMMAND_MAX_CHARS
  }
  return utf8ByteLength(commandText) > POSIX_COMMAND_MAX_BYTES
}

/** Same check for an argv that has not been quoted into shell text yet, plus any
 *  trailing command clause the plan appends. */
export function startupArgvExceedsShellLimit(
  argv: readonly string[],
  shell: AgentStartupShell,
  commandSuffix = ''
): boolean {
  return startupCommandExceedsShellLimit(
    `${buildShellCommandFromArgv(argv, shell)}${commandSuffix}`,
    shell
  )
}
