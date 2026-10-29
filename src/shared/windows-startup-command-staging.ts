import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 as pathWin32 } from 'node:path'
import type { StartupCommandStaging } from './startup-command-staging'
import {
  STAGED_STARTUP_COMMAND_PREFIX,
  sweepStaleStagedStartupCommands
} from './startup-command-staging'
import { quoteStartupArg } from './tui-agent-startup-shell'

export type WindowsStartupCommandStagingArgs = {
  command: string
  shellPath: string
  directory?: string
  wslDistro?: string
}

let staleSweepStarted = false

export async function stageWindowsStartupCommand(
  args: WindowsStartupCommandStagingArgs
): Promise<StartupCommandStaging> {
  const shellName = pathWin32.basename(args.shellPath).toLowerCase()
  const kind =
    shellName === 'cmd.exe'
      ? 'cmd'
      : shellName === 'powershell.exe' || shellName === 'pwsh.exe'
        ? 'powershell'
        : shellName === 'wsl.exe'
          ? 'wsl'
          : shellName === 'bash.exe'
            ? 'bash'
            : null
  if (kind === null) {
    return {
      command: args.command,
      delivery: 'typed-after-stage-failed',
      failure: `Unsupported shell: ${shellName}`
    }
  }
  const directory = args.directory ?? tmpdir()
  if (!staleSweepStarted) {
    staleSweepStarted = true
    setTimeout(() => sweepStaleStagedStartupCommands({ directory }), 0).unref?.()
  }
  const extension = kind === 'cmd' ? '.cmd' : kind === 'powershell' ? '.ps1' : '.sh'
  const scriptPath = join(
    directory,
    `${STAGED_STARTUP_COMMAND_PREFIX}${randomBytes(8).toString('hex')}${extension}`
  )
  const body = args.command.replace(/\r\n|\r/g, '\n').replace(/\n$/, '')
  const guestPath = toWslPath(scriptPath)
  if (kind === 'wsl' && guestPath === null) {
    return {
      command: args.command,
      delivery: 'typed-after-stage-failed',
      failure: 'Temporary directory is not accessible from WSL'
    }
  }
  const bashPath = toGitBashPath(scriptPath)
  const content =
    kind === 'cmd'
      ? `${body.replace(/\n/g, '\r\n')}\r\ndel "%~f0" >nul 2>&1\r\n`
      : kind === 'powershell'
        ? `\uFEFF${body}\nRemove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue\n`
        : `rm -f -- "$0"\n${body}\n`
  try {
    writeFileSync(scriptPath, content, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    return {
      command: args.command,
      delivery: 'typed-after-stage-failed',
      failure: error instanceof Error ? error.message : String(error)
    }
  }
  const command =
    kind === 'cmd'
      ? `call ${quoteStartupArg(scriptPath, 'cmd')}`
      : kind === 'powershell'
        ? `& ${quoteStartupArg(scriptPath, 'powershell')}`
        : `sh ${quoteStartupArg(kind === 'wsl' ? (guestPath ?? '') : bashPath, 'posix')}`
  return { command, delivery: 'staged', scriptPath }
}

function toWslPath(path: string): string | null {
  const match = path.match(/^([A-Za-z]):\\(.*)$/)
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}` : null
}

function toGitBashPath(path: string): string {
  const match = path.match(/^([A-Za-z]):\\(.*)$/)
  return match
    ? `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
    : path.replace(/\\/g, '/')
}
