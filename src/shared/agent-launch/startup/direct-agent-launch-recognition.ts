import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import { readLaunchPosition } from './launch-position'
import { unwrapPowerShellNativeLaunch } from './powershell-native-launch'
import { unwrapCodexScopedImageCommand } from './codex-scoped-image-command'

export const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i

// Match the generated single-quoted script (including escaped apostrophes), then its argv marker.
const POSIX_WRAPPER = /^\/bin\/sh -c ((?:'[^']*'|"'"|"\\\\")+) (orca-codex|orca-claude) /

/** Read the invocation without pulling the host's wrapper scripts into consumers such as mobile. */
export function unwrapDirectAgentLaunchCommand(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (prefix.includes('/bin/sh -c ')) {
    const index = readLaunchPosition(prefix, 'posix')?.start
    if (index !== undefined) {
      const wrapper = POSIX_WRAPPER.exec(command.slice(index, index + COMMAND_TOKEN_SCAN_MAX_CHARS))
      if (wrapper) {
        const [, script, marker] = wrapper
        const generated =
          marker === 'orca-codex'
            ? script.startsWith("'p=$1; shift; i=${ORCA_CODEX_ISOLATE:-1}; ") &&
              script.endsWith('exec "$p" "$@"\'')
            : script.startsWith("'__orca_claude_hook_plugin() {") &&
              script.endsWith('exec "$__orca_claude_program" "$@"\'')
        if (generated) {
          return command.slice(index + wrapper[0].length)
        }
      }
    }
  }
  return unwrapPowerShellNativeLaunch(unwrapCodexScopedImageCommand(command))
}
