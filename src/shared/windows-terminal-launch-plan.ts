import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from './powershell-osc133-bootstrap'
import { isWindowsGitBashShellPath } from './windows-git-bash'
import {
  buildWslInteractiveLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from './wsl-login-shell-command'
import { parseWslUncPath, toLinuxPath, toWindowsWslPath } from './wsl-paths'
import {
  resolveWindowsPowerShellSpawnChain,
  type WindowsPowerShellResolveOptions
} from './windows-powershell-executable'
import {
  getWindowsPowerShellShellFamily,
  getWindowsShellBasename,
  isWindowsPowerShellShellPath
} from './windows-terminal-shell-resolution'
export {
  getWindowsPowerShellShellFamily,
  getWindowsShellBasename,
  isWindowsPowerShellShellPath,
  resolveEffectiveWindowsPowerShell,
  resolveWindowsPowerShellShellPath,
  resolveWindowsTerminalShellPath,
  shouldLaunchWindowsPowerShellWithoutProfile,
  shouldProbeWindowsPowerShellAvailability
} from './windows-terminal-shell-resolution'
export type {
  WindowsPowerShellImplementation,
  WindowsPowerShellShellFamily,
  WindowsTerminalShellPathOptions
} from './windows-terminal-shell-resolution'

const CMD_EXE_COMMAND_LINE_MAX_CHARS = 8191
const STARTUP_COMMAND_TEXT_MAX_CHARS = 6000
const CMD_UTF8_SETUP_COMMAND = 'chcp 65001 > nul'

export type WindowsShellLaunchArgs = {
  shellArgs: string[]
  startupCommandDeliveredInShellArgs?: boolean
  effectiveCwd: string
  validationCwd: string
}

export type WindowsShellWslContext = {
  distro: string
  treatPosixCwdAsWsl?: boolean
}

export type WindowsShellLaunchOptions = {
  powerShellNoProfile?: boolean
}

export type WindowsShellSpawnAttempt = {
  shellPath: string
  shellArgs: string[]
  effectiveCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
}

export type WindowsStartupCommandDelivery = 'none' | 'stdin' | 'stdin-after-marker' | 'shell-args'

export type WindowsTerminalLaunchPlan = WindowsShellSpawnAttempt & {
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
  startupCommandDelivery: WindowsStartupCommandDelivery
  requiresShellReadyMarker: boolean
}

function getCmdShellArgStartupCommand(command?: string): string | null {
  if (!command || command.length > STARTUP_COMMAND_TEXT_MAX_CHARS) {
    return null
  }
  const commandArg = `${CMD_UTF8_SETUP_COMMAND} & ${command}`
  if (commandArg.length > CMD_EXE_COMMAND_LINE_MAX_CHARS) {
    return null
  }
  return command
}

function getPowerShellBootstrapEncodedCommand(): string {
  return encodePowerShellCommand(getPowerShellOsc133Bootstrap())
}

function buildWslShellArgs(linuxCwd: string, distro?: string): string[] {
  const setupCommand = [
    `cd ${quotePosixShell(linuxCwd)}`,
    'export PATH="$HOME/.local/bin:$PATH"',
    buildWslInteractiveLoginShellCommand()
  ].join(' && ')
  const shellArgs = ['--', 'sh', '-c', escapeWslShCommandForWindows(setupCommand)]
  return distro ? ['-d', distro, ...shellArgs] : shellArgs
}

function normalizeMsysDrivePath(cwd: string): string {
  const match = cwd.match(/^\/([A-Za-z])(?:\/(.*))?$/)
  if (!match) {
    return cwd
  }

  const driveLetter = match[1].toUpperCase()
  const rest = match[2]?.replace(/\//g, '\\') ?? ''
  return rest ? `${driveLetter}:\\${rest}` : `${driveLetter}:\\`
}

function getStartupCommandDelivery(args: {
  startupCommand?: string
  startupCommandDeliveredInShellArgs: boolean
  shellPath: string
}): WindowsStartupCommandDelivery {
  if (!args.startupCommand) {
    return 'none'
  }
  if (args.startupCommandDeliveredInShellArgs) {
    return 'shell-args'
  }
  return isWindowsPowerShellShellPath(args.shellPath) ? 'stdin-after-marker' : 'stdin'
}

function toAttempt(
  shellPath: string,
  cwd: string,
  defaultCwd: string,
  wslContext: WindowsShellWslContext | undefined,
  startupCommand: string | undefined,
  launchOptions: WindowsShellLaunchOptions | undefined
): WindowsShellSpawnAttempt {
  const resolved = resolveWindowsShellLaunchArgs(
    shellPath,
    cwd,
    defaultCwd,
    wslContext,
    startupCommand,
    launchOptions
  )
  return {
    shellPath,
    shellArgs: resolved.shellArgs,
    effectiveCwd: resolved.effectiveCwd,
    validationCwd: resolved.validationCwd,
    startupCommandDeliveredInShellArgs: resolved.startupCommandDeliveredInShellArgs === true
  }
}

export function resolveWindowsShellLaunchArgs(
  shellPath: string,
  cwd: string,
  defaultCwd: string,
  wslContext?: WindowsShellWslContext,
  startupCommand?: string,
  options?: WindowsShellLaunchOptions
): WindowsShellLaunchArgs {
  const shellBasename = getWindowsShellBasename(shellPath)
  const nativeCwd = normalizeMsysDrivePath(cwd)
  const isMsysDriveCwd = nativeCwd !== cwd

  if (shellBasename === 'cmd.exe' || shellBasename === 'cmd') {
    const shellArgStartupCommand = getCmdShellArgStartupCommand(startupCommand)
    return {
      shellArgs: [
        '/K',
        shellArgStartupCommand
          ? `${CMD_UTF8_SETUP_COMMAND} & ${shellArgStartupCommand}`
          : CMD_UTF8_SETUP_COMMAND
      ],
      ...(shellArgStartupCommand ? { startupCommandDeliveredInShellArgs: true } : {}),
      effectiveCwd: nativeCwd,
      validationCwd: nativeCwd
    }
  }

  if (isWindowsPowerShellShellPath(shellPath)) {
    return {
      shellArgs: [
        '-NoLogo',
        ...(options?.powerShellNoProfile ? ['-NoProfile'] : []),
        '-NoExit',
        '-EncodedCommand',
        getPowerShellBootstrapEncodedCommand()
      ],
      effectiveCwd: nativeCwd,
      validationCwd: nativeCwd
    }
  }

  if (isWindowsGitBashShellPath(shellPath)) {
    return {
      shellArgs: ['--login', '-i'],
      effectiveCwd: nativeCwd,
      validationCwd: nativeCwd
    }
  }

  if (shellBasename === 'wsl.exe' || shellBasename === 'wsl') {
    const wslInfo = parseWslUncPath(cwd)
    if (wslInfo) {
      return {
        shellArgs: buildWslShellArgs(wslInfo.linuxPath, wslInfo.distro),
        effectiveCwd: defaultCwd,
        validationCwd: cwd
      }
    }
    if (wslContext?.treatPosixCwdAsWsl && cwd.startsWith('/') && !isMsysDriveCwd) {
      return {
        shellArgs: buildWslShellArgs(cwd, wslContext.distro),
        effectiveCwd: defaultCwd,
        validationCwd: toWindowsWslPath(cwd, wslContext.distro)
      }
    }
    const driveMatch = nativeCwd.replace(/\\/g, '/').match(/^([A-Za-z]):\/?(.*)$/)
    const linuxCwd = driveMatch ? toLinuxPath(nativeCwd) : '/mnt/c'
    return {
      shellArgs: buildWslShellArgs(linuxCwd, wslContext?.distro),
      effectiveCwd: defaultCwd,
      validationCwd: nativeCwd
    }
  }

  return {
    shellArgs: [],
    effectiveCwd: nativeCwd,
    validationCwd: nativeCwd
  }
}

export function buildWindowsPowerShellSpawnAttempts(args: {
  shellPath: string
  cwd: string
  defaultCwd: string
  wslContext?: WindowsShellWslContext
  startupCommand?: string
  launchOptions?: WindowsShellLaunchOptions
  resolveOptions?: WindowsPowerShellResolveOptions
}): WindowsShellSpawnAttempt[] {
  const family = getWindowsPowerShellShellFamily(args.shellPath)
  if (!family) {
    return []
  }
  const chain = resolveWindowsPowerShellSpawnChain(family, args.resolveOptions)
  return chain.map((candidate) =>
    toAttempt(
      candidate,
      args.cwd,
      args.defaultCwd,
      args.wslContext,
      args.startupCommand,
      args.launchOptions
    )
  )
}

export function resolveWindowsTerminalLaunchPlan(args: {
  shellPath: string
  cwd: string
  defaultCwd: string
  wslContext?: WindowsShellWslContext
  startupCommand?: string
  launchOptions?: WindowsShellLaunchOptions
  resolveOptions?: WindowsPowerShellResolveOptions
}): WindowsTerminalLaunchPlan {
  const windowsFallbackAttempts = buildWindowsPowerShellSpawnAttempts(args)
  const primaryAttempt =
    windowsFallbackAttempts[0] ??
    toAttempt(
      args.shellPath,
      args.cwd,
      args.defaultCwd,
      args.wslContext,
      args.startupCommand,
      args.launchOptions
    )
  const startupCommandDelivery = getStartupCommandDelivery({
    startupCommand: args.startupCommand,
    startupCommandDeliveredInShellArgs: primaryAttempt.startupCommandDeliveredInShellArgs,
    shellPath: primaryAttempt.shellPath
  })

  return {
    ...primaryAttempt,
    windowsFallbackAttempts,
    startupCommandDelivery,
    requiresShellReadyMarker: startupCommandDelivery === 'stdin-after-marker'
  }
}
