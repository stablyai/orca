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
  CODEX_SHARED_SERVER_ARGS,
  identitySetArg
} from '../../shell/launch/agents/codex-shell-function'
import { extractLeadingEnvAssignments } from '../../shell/launch/command-environment'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i

// What the interactive `codex` shell function adds, for a literal target (such as Orca's own copy by
// full path) that bypasses it: hook prep, caller identity for commands Codex runs, the remote-viewer
// clipboard marker, and optionally the image hint. --no-daemon is added at spawn.
const posixScript = (images: boolean): string =>
  [
    'p=$1; shift; i=${ORCA_CODEX_ISOLATE:-1}',
    `for a in "$@"; do case "$a" in ${CODEX_SHARED_SERVER_ARGS.join('|')}|--remote=*) i=0 ;; esac; done`,
    'if [ -n "${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" ] && [ -x "$ORCA_CODEX_LAUNCH_PREFLIGHT" ]; then "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1 || :; fi',
    `if [ "\${${REMOTE_VIEWER_CLIPBOARD_ENV}:-}" = 1 ] && [ -z "\${SSH_CONNECTION+x}" ] && [ -z "\${SSH_TTY+x}" ]; then export SSH_CONNECTION='${CODEX_REMOTE_VIEWER_SSH_CONNECTION}'; fi`,
    `if [ "$i" != 0 ]; then for k in ${CODEX_COMMAND_IDENTITY_ENV_KEYS.join(' ')}; do eval "v=\\\${$k:-}"; case "$v" in ''|*"'"*) ;; *) set -- -c "${identitySetArg('$k', '$v')}" "$@" ;; esac; done; [ "\${SSH_CONNECTION:-}" != '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}' ] || set -- -c "${CLEAR_SSH_MARKER_ARG}" "$@"; fi`,
    ...(images
      ? [
          `if [ "$${ORCA_IMAGE_PROTOCOL_ENV}" = ${ORCA_IMAGE_PROTOCOL_VALUE} ] && [ -z "\${KITTY_WINDOW_ID+x}" ]; then export KITTY_WINDOW_ID=${CODEX_KITTY_WINDOW_ID}; fi`
        ]
      : []),
    'exec "$p" "$@"'
  ].join('; ')

const posixPrefix = (images: boolean): string =>
  `/bin/sh -c ${quoteStartupArg(posixScript(images), 'posix')} orca-codex `

const IDENTITY_SPLAT = ' @orcaCodexIdentity'

function powerShellPrefix(images: boolean, identity: boolean): string {
  const remote = `$orcaRemoteClipboard = $env:${REMOTE_VIEWER_CLIPBOARD_ENV} -eq '1' -and -not (Test-Path Env:SSH_CONNECTION) -and -not (Test-Path Env:SSH_TTY); `
  const ids = identity
    ? `if ($env:ORCA_CODEX_ISOLATE -ne '0') { foreach ($k in ${CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => `'${key}'`).join(',')}) { $v = [Environment]::GetEnvironmentVariable($k); if ($v -and -not $v.Contains("'")) { $orcaCodexIdentity += '-c', "${identitySetArg('$k', '$v')}" } }; if ($orcaRemoteClipboard -or $env:SSH_CONNECTION -ceq '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}') { $orcaCodexIdentity += '-c', "${CLEAR_SSH_MARKER_ARG}" } }; `
    : ''
  const kitty = images
    ? `$orcaKitty = $env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}' -and -not (Test-Path Env:KITTY_WINDOW_ID); if ($orcaKitty) { $env:KITTY_WINDOW_ID = '${CODEX_KITTY_WINDOW_ID}' }; `
    : ''
  return (
    `& { if ($env:ORCA_CODEX_LAUNCH_PREFLIGHT) { try { & $env:ORCA_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null } catch { } }; ` +
    `${remote}$orcaCodexIdentity = @(); ${ids}` +
    `if ($orcaRemoteClipboard) { $env:SSH_CONNECTION = '${CODEX_REMOTE_VIEWER_SSH_CONNECTION}' }; ${kitty}try { `
  )
}

const powerShellSuffix = (images: boolean): string =>
  ` } finally { if ($orcaRemoteClipboard) { Remove-Item Env:SSH_CONNECTION }${images ? '; if ($orcaKitty) { Remove-Item Env:KITTY_WINDOW_ID }' : ''} } }`

const BOTH = [true, false] as const
// Built once: recognition unwraps process command lines often.
const POSIX_PREFIXES = new Map(BOTH.map((images) => [images, posixPrefix(images)]))
const POWERSHELL_WRAPPERS = BOTH.flatMap((images) =>
  BOTH.map((identity) => ({
    images,
    identity,
    prefix: powerShellPrefix(images, identity),
    suffix: powerShellSuffix(images)
  }))
)

/** Bare Codex uses the interactive shell function. Give literal targets that bypass it what it adds. */
export function withCodexDirectLaunchCommand(
  command: string,
  shell: AgentStartupShell,
  options: { images: boolean }
): string {
  // cmd has no interactive setlocal scope. Keep its existing startup command and quoting.
  if (shell === 'cmd') {
    return command
  }
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok || /[\r\n]/.test(command)) {
    return command
  }
  const firstSpan = parsed.spans[0]
  const first = firstSpan && command.slice(firstSpan.start, firstSpan.end)
  const hasCallOperator =
    shell === 'powershell' ? first === '&' : first === 'command' || first === 'exec'
  const envCommand = shell === 'posix' && first === 'env'
  const index = envCommand
    ? parsed.tokens.length - extractLeadingEnvAssignments(parsed.tokens.slice(1)).rest.length
    : Number(hasCallOperator)
  const executable = parsed.tokens[index]
  if (
    !executable ||
    !CODEX_EXECUTABLE.test(executable.split(/[\\/]/).at(-1) ?? '') ||
    parsed.spans
      .slice(shell === 'powershell' && hasCallOperator ? 1 : 0)
      .some((span) => span.divergesFromShell)
  ) {
    return command
  }
  if (shell === 'powershell') {
    if (executable.toLowerCase() === 'codex' || parsed.tokens.includes('--%')) {
      return command
    }
    const args = parsed.tokens.slice(index + 1)
    const identity = !args.some(
      (arg) =>
        (CODEX_SHARED_SERVER_ARGS as readonly string[]).includes(arg) || arg.startsWith('--remote=')
    )
    const end = parsed.spans[index].end
    const launch = `${command.slice(0, end)}${identity ? IDENTITY_SPLAT : ''}${command.slice(end)}`
    // Without the call operator PowerShell parses a quoted path as a string expression (#46114).
    const callOperator = `'"`.includes(command[firstSpan.start]) ? '& ' : ''
    const wrapper = POWERSHELL_WRAPPERS.find(
      (each) => each.images === options.images && each.identity === identity
    )
    return wrapper ? `${wrapper.prefix}${callOperator}${launch}${wrapper.suffix}` : command
  }
  if (index === 0 && executable === 'codex') {
    return command
  }
  const start = parsed.spans[index].start
  return `${command.slice(0, start)}${POSIX_PREFIXES.get(options.images)}${command.slice(start)}`
}

/** Recognize the original startup executable and flags through the generated command. */
export function unwrapCodexDirectLaunchCommand(command: string): string {
  const trimmed = command.trimStart()
  for (const prefix of POSIX_PREFIXES.values()) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length)
    }
  }
  for (const { prefix, suffix } of POWERSHELL_WRAPPERS) {
    if (command.startsWith(prefix) && command.endsWith(suffix)) {
      return command.slice(prefix.length, -suffix.length).replace(IDENTITY_SPLAT, '')
    }
  }
  return command
}
