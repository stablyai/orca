/** Stage long/multiline launches on the PTY host: ready markers may precede raw mode, so MAX_CANON truncates long lines
 * (1024 bytes on macOS), and raw newlines submit early in bash 3.2. Self-delete scripts before starting the agent. */
import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasControlByte, TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES } from './startup-line-prompt-carry'
import { quoteStartupArg } from './agent-launch/startup/tui-agent-startup-shell'

export const STAGED_STARTUP_COMMAND_PREFIX = 'orca-launch-'

/** Which delivery ran for a spawn's typed startup line, decided by the host that owns the PTY. */
export type StartupLineDelivery = 'typed' | 'staged' | 'typed-after-stage-failed'

/** Age past which a staged script is a crash leftover rather than another host's in-flight launch. */
export const STAGED_STARTUP_COMMAND_STALE_MS = 60 * 60 * 1000

export type StartupCommandStaging = {
  /** Typed command or short staged-script invocation. */
  command: string
  delivery: StartupLineDelivery
  /** Present while the script exists; the host unlinks it if the PTY exits before sourcing it. */
  scriptPath?: string
  /** Why staging failed, for the host's log. */
  failure?: string
}

// Only these shells preserve Orca’s portable quoting directly. Other shells use /bin/sh for nonplain Orca-built lines;
// user-authored commands retain their target shell’s syntax.
const STAGING_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'mksh'])

// ksh sourcing loses the agent’s process group/Ctrl-Z; use /bin/sh for long launches (mksh conservatively follows).
const SOURCING_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish'])

const encoder = new TextEncoder()

export function stagingShellName(shellPath: string | undefined): string | null {
  const name = shellPath?.split('/').pop()?.replace(/^-/, '').toLowerCase()
  return name && STAGING_SHELLS.has(name) ? name : null
}

function stripSubmitTerminator(command: string): string {
  return command.replace(/(\r\n|\r|\n)$/, '')
}

export function shouldStageStartupCommand(args: {
  command: string
  shellPath: string | undefined
  platform: NodeJS.Platform
  /** An agent launch line Orca built with POSIX quoting, which sh can run in any shell. */
  orcaBuiltLine?: boolean
  /**
   * This PTY host is an Orca Cloud VM: an Orca-built agent line is always staged, so the pane shows
   * `. /tmp/orca-launch-….sh` instead of the agent's flags, plugin path and prompt (CR-cmd).
   */
  cloudHost?: boolean
}): boolean {
  if (args.platform === 'win32') {
    return false
  }
  const shellName = stagingShellName(args.shellPath)
  const body = stripSubmitTerminator(args.command)
  const needsStaging =
    (args.cloudHost === true && args.orcaBuiltLine === true) ||
    hasControlByte(body) ||
    encoder.encode(body).byteLength > TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
  if (shellName === null) {
    // tcsh mutates backslashes/!! and nu rejects POSIX apostrophe escapes; type plain lines directly to retain foreground-job detection.
    return args.orcaBuiltLine === true && (needsStaging || /[!\\"`$]/.test(body))
  }
  return needsStaging && (SOURCING_SHELLS.has(shellName) || args.orcaBuiltLine === true)
}

function stagedScriptLine(shellName: string | null, quotedPath: string): string {
  if (shellName === 'fish') {
    // fish sourcing loses job control; eval preserves typed-line behavior.
    return `eval (string collect < ${quotedPath})`
  }
  return shellName !== null && SOURCING_SHELLS.has(shellName)
    ? `. ${quotedPath}`
    : `/bin/sh ${quotedPath}`
}

/** Shells whose prompt and history the cloud quiet prelude knows how to handle (CR-cmd-quiet). */
const QUIET_SHELLS = new Set(['bash', 'zsh'])

/**
 * CR-cmd-quiet (design-squad): on an Orca Cloud host the staged line is Orca's, not the user's, so it
 * leaves no trace. Runs first in the sourced script, before the agent draws:
 * - erases the rows the shell echoed for the prompt and the typed line, so the pane's first visible
 *   row is the agent's own output; nothing below them is touched;
 * - drops the line from bash's history (zsh skips it with the image's zshaddhistory hook, since zsh
 *   records a line before running it; the leading space also covers HISTCONTROL=ignorespace).
 * Errors from the launch still print: only the echo of the command is cleared.
 */
export function cloudQuietPrelude(typedLine: string): string {
  // Display width of the typed line (ASCII: a quoted /tmp path).
  const typedWidth = [...typedLine].length
  // String.raw: this is shell, so its backslashes and ${...} must reach the script as written.
  return String.raw`__orca_q_esc=$(printf '\033'); __orca_q_bel=$(printf '\007')
__orca_q_cols=${'$'}{COLUMNS:-0}
case $__orca_q_cols in '' | *[!0-9]* | 0) __orca_q_cols=$(tput cols 2>/dev/null || echo 80) ;; esac
__orca_q_prompt=
if [ -n "${'$'}{BASH_VERSION-}" ]; then
  eval '__orca_q_prompt=${'$'}{PS1@P}' 2>/dev/null
  __orca_q_h=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
  case $__orca_q_h in
    *${STAGED_STARTUP_COMMAND_PREFIX}*)
      __orca_q_h=${'$'}{__orca_q_h#"${'$'}{__orca_q_h%%[0-9]*}"}
      builtin history -d "${'$'}{__orca_q_h%%[!0-9]*}" 2>/dev/null
      ;;
  esac
elif [ -n "${'$'}{ZSH_VERSION-}" ]; then
  eval '__orca_q_prompt=${'$'}{(%)PS1}' 2>/dev/null
fi
__orca_q_prompt=$(printf '%s' "$__orca_q_prompt" | LC_ALL=C sed -e "s/${'$'}{__orca_q_esc}\[[0-9;?]*[ -\/]*[@-~]//g" -e "s/${'$'}{__orca_q_esc}\][^${'$'}{__orca_q_bel}]*${'$'}{__orca_q_bel}//g" | tr -d '\001\002' | tail -n 1)
__orca_q_rows=$(( (${'$'}{#__orca_q_prompt} + ${typedWidth} + __orca_q_cols - 1) / __orca_q_cols ))
[ "$__orca_q_rows" -ge 1 ] 2>/dev/null || __orca_q_rows=1
printf '\r\033[%dA\033[J' "$__orca_q_rows"
unset __orca_q_esc __orca_q_bel __orca_q_cols __orca_q_prompt __orca_q_h __orca_q_rows`
}

let staleSweepStarted = false

export function stageStartupCommand(args: {
  command: string
  shellPath: string | undefined
  orcaBuiltLine?: boolean
  platform?: NodeJS.Platform
  directory?: string
  /** Defaults to this process being orcad on an Orca Cloud VM (ORCA_IS_CLOUD=1, set by the image). */
  cloudHost?: boolean
}): StartupCommandStaging {
  const platform = args.platform ?? process.platform
  const cloudHost = args.cloudHost ?? process.env.ORCA_IS_CLOUD === '1'
  if (!shouldStageStartupCommand({ ...args, platform, cloudHost })) {
    return { command: args.command, delivery: 'typed' }
  }
  const directory = args.directory ?? tmpdir()
  if (!staleSweepStarted) {
    staleSweepStarted = true
    // Crash cleanup must not delay launch.
    setTimeout(() => sweepStaleStagedStartupCommands({ directory }), 0).unref?.()
  }
  const shellName = stagingShellName(args.shellPath)
  const scriptPath = join(
    directory,
    `${STAGED_STARTUP_COMMAND_PREFIX}${randomBytes(8).toString('hex')}.sh`
  )
  const quotedPath = quoteStartupArg(scriptPath, 'posix')
  // CR-cmd-quiet: Orca's own agent line on a cloud host leaves no echo and no history entry.
  const quiet =
    cloudHost && args.orcaBuiltLine === true && shellName !== null && QUIET_SHELLS.has(shellName)
  // The leading space keeps it out of history wherever HISTCONTROL/HIST_IGNORE_SPACE is set.
  const typedLine = `${quiet ? ' ' : ''}${stagedScriptLine(shellName, quotedPath)}`
  try {
    // Unlink before the agent starts; the shell continues reading its open file.
    writeFileSync(
      scriptPath,
      `command rm -f -- ${quotedPath}\n${quiet ? `${cloudQuietPrelude(typedLine)}\n` : ''}${stripSubmitTerminator(args.command)}\n`,
      { mode: 0o600, flag: 'wx' }
    )
  } catch (error) {
    return {
      command: args.command,
      delivery: 'typed-after-stage-failed',
      failure: error instanceof Error ? error.message : String(error)
    }
  }
  return { command: typedLine, delivery: 'staged', scriptPath }
}

/** Explain fallback because the full typed line may leave the shell awaiting more input. */
export function startupStagingFailureNotice(staging: StartupCommandStaging): string | null {
  if (staging.failure === undefined) {
    return null
  }
  const reason = [...staging.failure]
    .map((char) => (char < ' ' || char === '\x7f' ? ' ' : char))
    .join('')
  return `\r\n[orca] Could not stage the launch command (${reason}); typed it in full. If the shell shows quote> or waits for more input, press Ctrl-C and launch again.\r\n`
}

export function discardStagedStartupCommand(staging: StartupCommandStaging | undefined): void {
  if (!staging?.scriptPath) {
    return
  }
  try {
    rmSync(staging.scriptPath, { force: true })
  } catch {
    // The age-gated sweep is the fallback.
  }
}

/** Age-gate crash cleanup so another instance’s fresh launch survives. */
export function sweepStaleStagedStartupCommands(args: { directory?: string; now?: number }): void {
  const directory = args.directory ?? tmpdir()
  const now = args.now ?? Date.now()
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(STAGED_STARTUP_COMMAND_PREFIX) || !name.endsWith('.sh')) {
      continue
    }
    const path = join(directory, name)
    try {
      if (now - statSync(path).mtimeMs > STAGED_STARTUP_COMMAND_STALE_MS) {
        rmSync(path, { force: true })
      }
    } catch {
      // Raced another instance's sweep.
    }
  }
}
