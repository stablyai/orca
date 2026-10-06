/**
 * Stages a long or multi-line startup command as a self-deleting script so the
 * host types only a short line that sources it.
 *
 * Why: the shell-ready marker fires before the line editor takes the TTY out of
 * canonical mode, so a typed line past MAX_CANON (1024 bytes on macOS) is
 * silently truncated, and macOS bash 3.2 reads each raw newline as Enter. Run
 * by the host that owns the PTY, at the moment it accepts the spawn.
 */
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { quoteStartupArg } from './tui-agent-startup-shell'
import { typedStartupLineFits } from './typed-startup-line'
import type { WslLaunchDirectory } from './wsl-launch-directory'

export const STAGED_STARTUP_COMMAND_PREFIX = 'orca-launch-'

/** Which delivery ran for a spawn's typed startup line, decided by the host that owns the PTY. */
export type StartupLineDelivery = 'typed' | 'staged' | 'typed-after-stage-failed'

/** Age past which a staged script is a crash leftover rather than another host's in-flight launch. */
export const STAGED_STARTUP_COMMAND_STALE_MS = 60 * 60 * 1000

export type StartupCommandStaging = {
  /** What the host types: the command itself, or a short line sourcing the staged script. */
  command: string
  delivery: StartupLineDelivery
  /** Present while the script exists; the host unlinks it if the PTY exits before sourcing it. */
  scriptPath?: string
  /** Why staging failed, for the host's log. */
  failure?: string
  /** The failed write's folder fails its writable check now (this host's temp folder), so the host
   *  types the line as main typed it; a plan made in main checked the same folder and planned for
   *  that. Otherwise the folder looked usable (a WSL distro's found by its probe, or a temp folder
   *  that passes the check, as when the disk is full) and the write still failed: a race, refused.
   *  A temp folder that turns unwritable between the plan and the spawn reads as unusable here. */
  folderUnusable?: true
}

// Why only these type any short line as is: Orca's portable quoting is verified literal in these. Any
// other shell (tcsh, nu, xonsh, pwsh...) runs an agent launch line Orca built through `/bin/sh` when
// it holds anything but plain characters; a command the user wrote for that shell is typed as it was.
const STAGING_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'mksh'])

// Why not ksh: it runs a sourced file's commands in the shell's own process group, so Ctrl-Z could
// not stop the agent (mksh untested, kept with it); their long Orca-built lines use `/bin/sh`.
const SOURCING_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish'])

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
}): boolean {
  if (args.platform === 'win32') {
    return false
  }
  const shellName = stagingShellName(args.shellPath)
  const needsStaging = startupLineNeedsStaging(args.command)
  if (shellName === null) {
    // Why these characters: tcsh doubles a quoted backslash and expands `!!`, and nu cannot read
    // `'\''`. A plain line is typed so the agent is the shell's own job, where the paste guard finds it.
    return (
      args.orcaBuiltLine === true &&
      (needsStaging || /[!\\"`$]/.test(stripSubmitTerminator(args.command)))
    )
  }
  return needsStaging && (SOURCING_SHELLS.has(shellName) || args.orcaBuiltLine === true)
}

/** Whether a line is too long or multi-line to type as it is, in a shell that can source a script. */
export function startupLineNeedsStaging(command: string): boolean {
  return !typedStartupLineFits(stripSubmitTerminator(command))
}

function stagedScriptLine(shellName: string | null, quotedPath: string): string {
  if (shellName === 'fish') {
    // Why eval: fish runs a sourced file without job control; eval runs it as if typed.
    return `eval (string collect < ${quotedPath})`
  }
  return shellName !== null && SOURCING_SHELLS.has(shellName)
    ? `. ${quotedPath}`
    : `/bin/sh ${quotedPath}`
}

const sweptDirectories = new Set<string>()

export function stageStartupCommand(args: {
  command: string
  shellPath: string | undefined
  orcaBuiltLine?: boolean
  platform?: NodeJS.Platform
  directory?: string
  /** A WSL session stages like a POSIX host in its login shell: written over UNC, sourced by its
   *  Linux path. */
  wslDirectory?: WslLaunchDirectory
}): StartupCommandStaging {
  const wsl = args.wslDirectory
  const platform = wsl ? 'linux' : (args.platform ?? process.platform)
  // Why the distro's shell: the host sees only wsl.exe, and /bin/sh would skip the pane's own
  // functions (Orca's codex wrapper, the user's aliases).
  const shellPath = wsl ? wsl.shell : args.shellPath
  if (!shouldStageStartupCommand({ ...args, shellPath, platform })) {
    return { command: args.command, delivery: 'typed' }
  }
  const directory = wsl?.windowsPath ?? args.directory ?? tmpdir()
  if (!sweptDirectories.has(directory)) {
    sweptDirectories.add(directory)
    // Why deferred: the sweep is crash recovery and must never delay this launch.
    setTimeout(() => sweepStaleStagedStartupCommands({ directory }), 0).unref?.()
  }
  const shellName = stagingShellName(shellPath)
  const scriptName = `${STAGED_STARTUP_COMMAND_PREFIX}${randomBytes(8).toString('hex')}.sh`
  const scriptPath = join(directory, scriptName)
  const quotedPath = quoteStartupArg(
    wsl ? posix.join(wsl.linuxPath, scriptName) : scriptPath,
    'posix'
  )
  try {
    if (wsl) {
      mkdirSync(directory, { recursive: true })
    }
    // Why rm first: the shell keeps reading the open file, so the prompt-bearing script is gone
    // before the agent starts, however long it runs.
    writeFileSync(
      scriptPath,
      `command rm -f -- ${quotedPath}\n${stripSubmitTerminator(args.command)}\n`,
      { mode: 0o600, flag: 'wx' }
    )
  } catch (error) {
    return {
      command: args.command,
      delivery: 'typed-after-stage-failed',
      failure: error instanceof Error ? error.message : String(error),
      ...(!wsl && !folderWritable(directory) ? { folderUnusable: true } : {})
    }
  }
  return {
    command: stagedScriptLine(shellName, quotedPath),
    delivery: 'staged',
    scriptPath
  }
}

function folderWritable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The line the host prints to the terminal when staging failed: the full line it types instead may
 * leave the shell waiting for more input, and nothing else would tell the user why.
 */
export function startupStagingFailureNotice(staging: StartupCommandStaging): string | null {
  if (staging.failure === undefined) {
    return null
  }
  const reason = [...staging.failure]
    .map((char) => (char < ' ' || char === '\x7f' ? ' ' : char))
    .join('')
  return `\r\n[orca] Could not stage the launch command (${reason}); typed it in full. If the shell shows quote> or waits for more input, press Ctrl-C and launch again.\r\n`
}

/** For a PTY that exited, or was never typed into, before it sourced its script. */
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

/** Removes scripts a crashed host left behind; age-gated so another instance's fresh launch survives. */
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
