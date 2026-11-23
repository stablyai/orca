import {
  CODEX_KITTY_WINDOW_ID,
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../terminal/images/terminal-image-protocol'
import {
  CODEX_REMOTE_VIEWER_SSH_CONNECTION,
  REMOTE_VIEWER_CLIPBOARD_ENV
} from '../../clipboard/remote-viewer-clipboard-env'
import {
  CLEAR_SSH_MARKER_ARG,
  CODEX_COMMAND_IDENTITY_ENV_KEYS,
  CODEX_NO_DAEMON_SKIP_ARG_PATTERN,
  CODEX_NO_DAEMON_SKIP_ARGS,
  CODEX_SHARED_SERVER_ARG_PATTERN,
  CODEX_SHARED_SERVER_ARGS,
  identitySetArg
} from '../../shell/launch/agents/codex-shell-function'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import {
  launchExecutableIs,
  readLaunchArguments,
  readLaunchPosition,
  type LaunchPosition
} from './launch-position'
import { powerShellNativeLaunch, unwrapPowerShellNativeLaunch } from './powershell-native-launch'
import {
  CLAUDE_DIRECT_POSIX_PREFIX,
  withClaudeDirectLaunchCommand
} from './claude-direct-launch-command'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

export const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i

// What the interactive `codex` shell function adds, for a literal target (such as Orca's own copy by
// full path) that bypasses it: hook prep, caller identity for commands Codex runs, the remote-viewer
// clipboard marker, and optionally the image hint. --no-daemon is added at spawn.
const posixScript = (images: boolean, probe: boolean): string =>
  [
    'p=$1; shift; i=${ORCA_CODEX_ISOLATE:-1}',
    `for a in "$@"; do case "$a" in ${CODEX_SHARED_SERVER_ARGS.join('|')}|--remote=*) i=0 ;; esac; done`,
    'if [ -n "${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" ] && [ -x "$ORCA_CODEX_LAUNCH_PREFLIGHT" ]; then "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1 || :; fi',
    `if [ "\${${REMOTE_VIEWER_CLIPBOARD_ENV}:-}" = 1 ] && [ -z "\${SSH_CONNECTION+x}" ] && [ -z "\${SSH_TTY+x}" ]; then export SSH_CONNECTION='${CODEX_REMOTE_VIEWER_SSH_CONNECTION}'; fi`,
    ...(probe
      ? [
          'd=$i',
          `for a in "$@"; do case "$a" in ${CODEX_NO_DAEMON_SKIP_ARGS.join('|')}|--remote=*) d=0 ;; esac; done`,
          'if [ "$d" != 0 ] && "$p" --help </dev/null 2>/dev/null | grep -q -- --no-daemon; then set -- --no-daemon "$@"; fi'
        ]
      : []),
    `if [ "$i" != 0 ]; then for k in ${CODEX_COMMAND_IDENTITY_ENV_KEYS.join(' ')}; do eval "v=\\\${$k:-}"; case "$v" in ''|*"'"*) ;; *) set -- -c "${identitySetArg('$k', '$v')}" "$@" ;; esac; done; [ "\${SSH_CONNECTION:-}" != '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}' ] || set -- -c "${CLEAR_SSH_MARKER_ARG}" "$@"; fi`,
    ...(images
      ? [
          `if [ "$${ORCA_IMAGE_PROTOCOL_ENV}" = ${ORCA_IMAGE_PROTOCOL_VALUE} ] && [ -z "\${KITTY_WINDOW_ID+x}" ]; then export KITTY_WINDOW_ID=${CODEX_KITTY_WINDOW_ID}; fi`
        ]
      : []),
    'exec "$p" "$@"'
  ].join('; ')

const posixPrefix = (images: boolean, probe: boolean): string =>
  `/bin/sh -c ${quoteStartupArg(posixScript(images, probe), 'posix')} orca-codex `

function powerShellPrefix(images: boolean, probe: boolean): string {
  const remote = `$orcaRemoteClipboard = $env:${REMOTE_VIEWER_CLIPBOARD_ENV} -eq '1' -and -not (Test-Path Env:SSH_CONNECTION) -and -not (Test-Path Env:SSH_TTY); `
  const ids = `if ($env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${CODEX_SHARED_SERVER_ARG_PATTERN}')) { foreach ($k in ${CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => `'${key}'`).join(',')}) { $v = [Environment]::GetEnvironmentVariable($k); if ($v -and -not $v.Contains("'")) { $orcaCodexIdentity += '-c', "${identitySetArg('$k', '$v')}" } }; if ($orcaRemoteClipboard -or $env:SSH_CONNECTION -ceq '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}') { $orcaCodexIdentity += '-c', "${CLEAR_SSH_MARKER_ARG}" } }; `
  const kitty = images
    ? `$orcaKitty = $env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}' -and -not (Test-Path Env:KITTY_WINDOW_ID); if ($orcaKitty) { $env:KITTY_WINDOW_ID = '${CODEX_KITTY_WINDOW_ID}' }; `
    : ''
  const daemon = probe
    ? `try { if ($env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${CODEX_NO_DAEMON_SKIP_ARG_PATTERN}') -and (& $orcaProgram --help 2>$null | Select-String -Quiet -SimpleMatch '--no-daemon')) { $orcaCodexIdentity += '--no-daemon' } } catch { }; `
    : ''
  return (
    `if ($env:ORCA_CODEX_LAUNCH_PREFLIGHT) { try { & $env:ORCA_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null } catch { } }; ` +
    `${remote}$orcaCodexIdentity = @(); ${ids}` +
    `if ($orcaRemoteClipboard) { $env:SSH_CONNECTION = '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}' }; ${kitty}try { ${daemon}`
  )
}

const powerShellSuffix = (images: boolean): string =>
  ` } finally { if ($orcaRemoteClipboard) { Remove-Item Env:SSH_CONNECTION }${images ? '; if ($orcaKitty) { Remove-Item Env:KITTY_WINDOW_ID }' : ''} }`

const BOTH = [true, false]
const NO_DAEMON_SKIP_ARGS: ReadonlySet<string> = new Set(CODEX_NO_DAEMON_SKIP_ARGS)
const POSIX_WRAPPERS = BOTH.flatMap((images) =>
  BOTH.map((probe) => ({ images, probe, prefix: posixPrefix(images, probe) }))
)

export function readCodexDirectLaunch(
  command: string,
  shell: AgentStartupShell
): {
  launch: LaunchPosition
  args: string[] | null
} | null {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (!/codex/i.test(prefix)) {
    return null
  }
  const launch = readLaunchPosition(command, shell)
  if (
    !launch ||
    !launchExecutableIs(launch.executable, CODEX_EXECUTABLE) ||
    (shell !== 'cmd' && launch.executable === 'codex' && !launch.bypassesShellFunction)
  ) {
    return null
  }
  const args = readLaunchArguments(command, shell, launch)
  if ((shell === 'cmd' && !args) || (shell !== 'posix' && args?.includes('--%'))) {
    return null
  }
  return { launch, args }
}

export function codexSkipsIsolationProbe(args: readonly string[]): boolean {
  return args.some((arg) => NO_DAEMON_SKIP_ARGS.has(arg) || arg.startsWith('--remote='))
}

export function withCodexDirectLaunchCommand(
  command: string,
  shell: AgentStartupShell,
  options: { images: boolean; probeInShell?: boolean },
  invocation = readCodexDirectLaunch(command, shell)
): string {
  if (shell === 'cmd' || !invocation) {
    return command
  }
  const { launch, args } = invocation
  const probe = !args || (options.probeInShell === true && !codexSkipsIsolationProbe(args))
  if (shell === 'powershell') {
    return powerShellNativeLaunch(
      command,
      launch,
      powerShellPrefix(options.images, probe),
      '$orcaCodexIdentity + ',
      powerShellSuffix(options.images)
    )
  }
  const wrapper = POSIX_WRAPPERS.find(
    (each) => each.images === options.images && each.probe === probe
  )
  return wrapper
    ? command.slice(0, launch.start) + wrapper.prefix + command.slice(launch.start)
    : command
}

export function prepareShellNativeAgentLaunch(
  command: string,
  shell: AgentStartupShell,
  images: boolean
): string {
  const codex = withCodexDirectLaunchCommand(command, shell, { images, probeInShell: true })
  return codex === command ? withClaudeDirectLaunchCommand(command, shell) : codex
}

/** Recover the invocation from Orca's direct launches for startup classification. */
export function unwrapDirectAgentLaunchCommand(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  const index = prefix.indexOf('/bin/sh -c ')
  if (index !== -1 && readLaunchPosition(command, 'posix')?.start === index) {
    if (command.startsWith(CLAUDE_DIRECT_POSIX_PREFIX, index)) {
      return command.slice(index + CLAUDE_DIRECT_POSIX_PREFIX.length)
    }
    for (const wrapper of POSIX_WRAPPERS) {
      if (command.startsWith(wrapper.prefix, index)) {
        return command.slice(index + wrapper.prefix.length)
      }
    }
  }
  return unwrapPowerShellNativeLaunch(command)
}
