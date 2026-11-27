import {
  POSIX_CODEX_IMAGE_HINT,
  POWERSHELL_CLEAR_CODEX_IMAGE_HINT,
  POWERSHELL_CODEX_IMAGE_HINT
} from './codex-scoped-image-command'
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
import { hasPowerShellStopParsing, powerShellNativeLaunch } from './powershell-native-launch'
import { withClaudeDirectLaunchCommand } from './claude-direct-launch-command'
import { setupPosixAgentExec } from './setup-agent-program'
import { CODEX_EXECUTABLE } from './direct-agent-launch-recognition'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

// What the interactive `codex` shell function adds, for a literal target (such as Orca's own copy by
// full path) that bypasses it: hook prep, caller identity for commands Codex runs, the remote-viewer
// clipboard marker, and optionally the image hint. --no-daemon is added at spawn.
const posixScript = (images: boolean, probe: boolean, setupGate: boolean): string =>
  [
    'p=$1; shift; i=${ORCA_CODEX_ISOLATE:-1}',
    `for a in "$@"; do case "$a" in ${CODEX_SHARED_SERVER_ARGS.join('|')}|--remote=*) i=0 ;; esac; done`,
    'if [ -n "${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" ] && [ -x "$ORCA_CODEX_LAUNCH_PREFLIGHT" ]; then "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1 || :; fi',
    `if [ "\${${REMOTE_VIEWER_CLIPBOARD_ENV}:-}" = 1 ] && [ -z "\${SSH_CONNECTION+x}" ] && [ -z "\${SSH_TTY+x}" ]; then export SSH_CONNECTION='${CODEX_REMOTE_VIEWER_SSH_CONNECTION}'; fi`,
    ...(probe
      ? [
          'd=$i',
          `for a in "$@"; do case "$a" in ${CODEX_NO_DAEMON_SKIP_ARGS.join('|')}|--remote=*) d=0 ;; esac; done`,
          `if [ "$d" != 0 ] && ${setupGate ? `(${setupPosixAgentExec('"$p"', '--help')})` : '"$p" --help'} </dev/null 2>/dev/null | grep -q -- --no-daemon; then set -- --no-daemon "$@"; fi`
        ]
      : []),
    `if [ "$i" != 0 ]; then for k in ${CODEX_COMMAND_IDENTITY_ENV_KEYS.join(' ')}; do eval "v=\\\${$k:-}"; case "$v" in ''|*"'"*) ;; *) set -- -c "${identitySetArg('$k', '$v')}" "$@" ;; esac; done; [ "\${SSH_CONNECTION:-}" != '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}' ] || set -- -c "${CLEAR_SSH_MARKER_ARG}" "$@"; fi`,
    ...(images ? [POSIX_CODEX_IMAGE_HINT] : []),
    setupGate ? setupPosixAgentExec('"$p"') : 'exec "$p" "$@"'
  ].join('; ')

const posixPrefix = (images: boolean, probe: boolean, setupGate: boolean): string =>
  `${setupGate ? 'bash' : '/bin/sh'} -c ${quoteStartupArg(posixScript(images, probe, setupGate), 'posix')} orca-codex `

function powerShellPrefix(images: boolean, probe: boolean): string {
  const remote = `$orcaRemoteClipboard = $env:${REMOTE_VIEWER_CLIPBOARD_ENV} -eq '1' -and -not (Test-Path Env:SSH_CONNECTION) -and -not (Test-Path Env:SSH_TTY); `
  const ids = `if ($env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${CODEX_SHARED_SERVER_ARG_PATTERN}')) { foreach ($k in ${CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => `'${key}'`).join(',')}) { $v = [Environment]::GetEnvironmentVariable($k); if ($v -and -not $v.Contains("'")) { $orcaCodexIdentity += '-c', "${identitySetArg('$k', '$v')}" } }; if ($orcaRemoteClipboard -or $env:SSH_CONNECTION -ceq '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}') { $orcaCodexIdentity += '-c', "${CLEAR_SSH_MARKER_ARG}" } }; `
  const kitty = images ? POWERSHELL_CODEX_IMAGE_HINT : ''
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
  ` } finally { if ($orcaRemoteClipboard) { Remove-Item Env:SSH_CONNECTION }${images ? `; ${POWERSHELL_CLEAR_CODEX_IMAGE_HINT}` : ''} }`

const BOTH = [true, false]
const NO_DAEMON_SKIP_ARGS: ReadonlySet<string> = /* @__PURE__ */ new Set(CODEX_NO_DAEMON_SKIP_ARGS)
const POSIX_WRAPPERS = /* @__PURE__ */ BOTH.flatMap((images) =>
  BOTH.flatMap((probe) =>
    BOTH.map((setupGate) => ({
      images,
      probe,
      setupGate,
      prefix: posixPrefix(images, probe, setupGate)
    }))
  )
)

export function readCodexDirectLaunch(
  command: string,
  shell: AgentStartupShell,
  allowByName = false
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
    (!allowByName &&
      shell !== 'cmd' &&
      launch.executable === 'codex' &&
      !launch.bypassesShellFunction)
  ) {
    return null
  }
  const args = readLaunchArguments(command, shell, launch)
  if (
    (shell === 'cmd' && (!args || args.includes('--%'))) ||
    (shell === 'powershell' && hasPowerShellStopParsing(command, launch))
  ) {
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
  options: { images: boolean; probeInShell?: boolean; programExpression?: string },
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
      powerShellSuffix(options.images),
      options.programExpression
    )
  }
  const wrapper = POSIX_WRAPPERS.find(
    (each) =>
      each.images === options.images &&
      each.probe === probe &&
      each.setupGate === Boolean(options.programExpression)
  )
  return wrapper
    ? command.slice(0, launch.start) +
        wrapper.prefix +
        (options.programExpression
          ? options.programExpression + command.slice(launch.end)
          : command.slice(launch.start))
    : command
}

export function prepareShellNativeAgentLaunch(
  command: string,
  shell: AgentStartupShell,
  images: boolean,
  options?: { allowByName?: boolean; probeInShell?: boolean }
): string {
  const codex = withCodexDirectLaunchCommand(
    command,
    shell,
    { images, probeInShell: options?.probeInShell ?? true },
    readCodexDirectLaunch(command, shell, options?.allowByName)
  )
  return codex === command
    ? withClaudeDirectLaunchCommand(command, shell, undefined, options?.allowByName)
    : codex
}
