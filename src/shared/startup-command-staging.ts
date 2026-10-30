/** Stage long/multiline launches on the PTY host: ready markers may precede raw mode, so MAX_CANON truncates long lines
 * (1024 bytes on macOS), and raw newlines submit early in bash 3.2. Self-delete scripts before starting the agent. */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasControlByte, TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES } from './startup-line-prompt-carry'
import { quoteStartupArg } from './tui-agent-startup-shell'

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
  directoryPath?: string
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
}): boolean {
  if (args.platform === 'win32') {
    return false
  }
  const shellName = stagingShellName(args.shellPath)
  const body = stripSubmitTerminator(args.command)
  const needsStaging =
    hasControlByte(body) || encoder.encode(body).byteLength > TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
  if (shellName === null) {
    // tcsh mutates backslashes/!! and nu rejects POSIX apostrophe escapes; type plain lines directly to retain foreground-job detection.
    return args.orcaBuiltLine === true && (needsStaging || /[!\\"`$]/.test(body))
  }
  return needsStaging && (SOURCING_SHELLS.has(shellName) || args.orcaBuiltLine === true)
}

function stagedScriptLine(shellName: string | null, quotedPath: string, owned?: true): string {
  if (owned && (shellName === 'ksh' || shellName === 'mksh')) {
    return `eval "$(command cat -- ${quotedPath})"`
  }
  if (shellName === 'fish') {
    // fish sourcing loses job control; eval preserves typed-line behavior.
    return `eval (string collect < ${quotedPath})`
  }
  return shellName !== null && SOURCING_SHELLS.has(shellName)
    ? `. ${quotedPath}`
    : `/bin/sh ${quotedPath}`
}

let staleSweepStarted = false

export function stageStartupCommand(args: {
  command: string
  shellPath: string | undefined
  orcaBuiltLine?: boolean
  platform?: NodeJS.Platform
  directory?: string
  owned?: true
}): StartupCommandStaging {
  const platform = args.platform ?? process.platform
  if (!shouldStageStartupCommand({ ...args, platform })) {
    return { command: args.command, delivery: 'typed' }
  }
  const directory = args.directory ?? tmpdir()
  if (!args.owned && !staleSweepStarted) {
    staleSweepStarted = true
    // Crash cleanup must not delay launch.
    setTimeout(() => sweepStaleStagedStartupCommands({ directory }), 0).unref?.()
  }
  const shellName = stagingShellName(args.shellPath)
  const directoryPath = args.owned ? mkdtempSync(join(directory, 'orca-owned-launch-')) : undefined
  const scriptPath = join(
    directoryPath ?? directory,
    `${STAGED_STARTUP_COMMAND_PREFIX}${randomBytes(8).toString('hex')}.sh`
  )
  const quotedPath = quoteStartupArg(scriptPath, 'posix')
  try {
    if (directoryPath) {
      chmodSync(directoryPath, 0o700)
    }
    // Unlink before the agent starts; the shell continues reading its open file.
    writeFileSync(
      scriptPath,
      `command rm -f -- ${quotedPath}\n${stripSubmitTerminator(args.command)}\n`,
      { mode: 0o600, flag: 'wx' }
    )
  } catch (error) {
    if (args.owned) {
      if (directoryPath) {
        rmSync(directoryPath, { recursive: true, force: true })
      }
      throw error
    }
    return {
      command: args.command,
      delivery: 'typed-after-stage-failed',
      failure: error instanceof Error ? error.message : String(error)
    }
  }
  return {
    command: stagedScriptLine(shellName, quotedPath, args.owned),
    delivery: 'staged',
    scriptPath,
    ...(directoryPath ? { directoryPath } : {})
  }
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
    if (staging.directoryPath) {
      rmSync(staging.directoryPath, { recursive: true, force: true })
    }
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
