import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import {
  getPosixClaudeDirectLaunchScript,
  getPowerShellClaudeDirectLaunchScope
} from '../../shell/launch/agents/claude-shell-function'
import { launchExecutableIs, readLaunchPosition } from './launch-position'
import { powerShellNativeLaunch } from './powershell-native-launch'
import { setupPosixAgentExec } from './setup-agent-program'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

const CLAUDE_EXECUTABLE = /^claude(?:\.(?:exe|cmd|bat))?$/i
const CLAUDE_DIRECT_POSIX_PREFIX = /* @__PURE__ */ (() =>
  `/bin/sh -c ${quoteStartupArg(getPosixClaudeDirectLaunchScript(), 'posix')} orca-claude `)()
const CLAUDE_SETUP_POSIX_PREFIX = /* @__PURE__ */ (() =>
  `bash -c ${quoteStartupArg(getPosixClaudeDirectLaunchScript(setupPosixAgentExec('"$__orca_claude_program"')), 'posix')} orca-claude `)()

export function withClaudeDirectLaunchCommand(
  command: string,
  shell: AgentStartupShell,
  programExpression?: string,
  allowByName = false
): string {
  if (shell === 'cmd' || !/claude/i.test(command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS))) {
    return command
  }
  const launch = readLaunchPosition(command, shell)
  if (
    !launch ||
    (!programExpression && !allowByName && !/[\\/]/.test(launch.executable)) ||
    !launchExecutableIs(launch.executable, CLAUDE_EXECUTABLE)
  ) {
    return command
  }
  if (shell === 'posix') {
    return (
      command.slice(0, launch.start) +
      (programExpression ? CLAUDE_SETUP_POSIX_PREFIX : CLAUDE_DIRECT_POSIX_PREFIX) +
      (programExpression
        ? programExpression + command.slice(launch.end)
        : command.slice(launch.start))
    )
  }
  const { before, after } = getPowerShellClaudeDirectLaunchScope()
  return powerShellNativeLaunch(command, launch, before, '', after, programExpression)
}
