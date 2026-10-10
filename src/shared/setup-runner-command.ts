import { isWindowsAbsolutePathLike } from './cross-platform-path'
import type { GlobalSettings } from './global-settings-types'
import {
  buildWindowsCmdRunnerDelayedLaunchCommand,
  windowsRunnerPathNeedsCmdGuard
} from './windows-cmd-runner-delayed-launch'

export type SetupRunnerCommandPlatform = 'windows' | 'posix'
export type SetupRunnerShellFamily = 'posix' | 'cmd'
export type SetupRunnerCommandShell = 'posix' | 'windows'
export type SetupRunnerShell = {
  family: SetupRunnerShellFamily
  executable?: string
}

export type SetupRunnerCommandResolution = {
  command: string
  runnerScriptPathForShell: string
  shell: SetupRunnerCommandShell
}

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  shell?: SetupRunnerShell
): string {
  return resolveSetupRunnerCommand(runnerScriptPath, platform, shell).command
}

export function getSetupRunnerCommandPlatformForPath(
  runnerScriptPath: string,
  fallbackPlatform: SetupRunnerCommandPlatform
): SetupRunnerCommandPlatform {
  if (isWindowsAbsolutePathLike(runnerScriptPath)) {
    return 'windows'
  }
  if (runnerScriptPath.startsWith('/')) {
    return 'posix'
  }
  return fallbackPlatform
}

export function resolveSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  shell?: SetupRunnerShell
): SetupRunnerCommandResolution {
  if (platform === 'windows') {
    if (isWslUncPath(runnerScriptPath)) {
      const linuxPath = wslUncToLinuxPath(runnerScriptPath)
      return {
        command: `bash ${quotePosixArg(linuxPath)}`,
        runnerScriptPathForShell: linuxPath,
        shell: 'posix'
      }
    }
    if (runnerScriptPath.startsWith('/') && !isWindowsAbsolutePathLike(runnerScriptPath)) {
      return {
        command: `bash ${quotePosixArg(runnerScriptPath)}`,
        runnerScriptPathForShell: runnerScriptPath,
        shell: 'posix'
      }
    }
    // Why: `shell` is the shell that types the command; the runner file's own extension decides
    // what can execute it. A batch runner never goes to bash even from a Git Bash pane.
    const cmdRunnerFile = isWindowsCmdRunnerPath(runnerScriptPath)
    if (!cmdRunnerFile && (shell?.family === 'posix' || /\.sh$/i.test(runnerScriptPath))) {
      // Why: WSL shells need /mnt/... paths, while Git Bash expects /c/... when replaying deferred setup scripts.
      if (isWslExecutable(shell?.executable)) {
        const wslPath = nativeWindowsPathToWslShellPath(runnerScriptPath)
        return {
          command: `bash ${quotePosixArg(wslPath)}`,
          runnerScriptPathForShell: wslPath,
          shell: 'posix'
        }
      }
      // Why: queued setup launches can outlive the process that generated them, so convert native paths before handing off to POSIX shells.
      const posixPath = nativeWindowsPathToPosixShellPath(runnerScriptPath)
      return {
        command: `bash ${quotePosixArg(posixPath)}`,
        runnerScriptPathForShell: posixPath,
        shell: 'posix'
      }
    }
    return {
      // Why: some path characters survive no amount of quoting on a cmd command line, and a Git
      // Bash pane rewrites the bare `/c` switch itself into a drive path (issue #6896) so cmd
      // opens interactively and the runner never starts. Both take the delayed-expansion
      // launcher, which passes the switch through a PowerShell ProcessStartInfo instead. Every
      // other case keeps the plain form.
      command:
        shell?.family === 'posix' || windowsRunnerPathNeedsCmdGuard(runnerScriptPath)
          ? buildWindowsCmdRunnerDelayedLaunchCommand(runnerScriptPath)
          : `cmd.exe /c ${quoteWindowsArg(runnerScriptPath)}`,
      runnerScriptPathForShell: runnerScriptPath,
      shell: 'windows'
    }
  }

  return {
    command: `bash ${quotePosixArg(runnerScriptPath)}`,
    runnerScriptPathForShell: runnerScriptPath,
    shell: 'posix'
  }
}

/** True when the runner file is a batch script, which only cmd can execute. */
export function isWindowsCmdRunnerPath(runnerScriptPath: string): boolean {
  return /\.(cmd|bat)$/i.test(runnerScriptPath)
}

export function isWslUncPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return /^\/\/(wsl\.localhost|wsl\$)\//i.test(normalized)
}

export function wslUncToLinuxPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i)
  return match?.[2] || '/'
}

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function nativeWindowsPathToPosixShellPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (driveMatch) {
    return `/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
  }
  return value.replace(/\\/g, '/')
}

function nativeWindowsPathToWslShellPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
  }
  return value.replace(/\\/g, '/')
}

function isWslExecutable(value: string | undefined): boolean {
  const basename = value?.trim().replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  return basename === 'wsl.exe' || basename === 'wsl'
}

const SETUP_SUCCESS_EXIT_SUFFIX = ' && exit'
// Why: Windows PowerShell 5.1 cannot parse `&&`; this form also runs in pwsh.
const POWERSHELL_SETUP_SUCCESS_EXIT_SUFFIX = '; if ($LASTEXITCODE -eq 0) { exit }'

/**
 * Appends a clause that exits the pane's shell when the setup command succeeds, so the pane
 * closes the way a typed `exit` closes it. `windowsTerminalShell` is the configured terminal
 * shell, needed because a cmd-family launch only says the runner is batch, not what types it.
 */
export function appendShellExitOnSetupSuccess(
  command: string,
  platform: SetupRunnerCommandPlatform,
  shell: SetupRunnerShell | undefined,
  windowsTerminalShell: string | undefined
): string {
  if (platform === 'posix' || shell?.family === 'posix') {
    return `${command}${SETUP_SUCCESS_EXIT_SUFFIX}`
  }
  // Why: no launch shell means a remote Windows host whose shell we cannot name; leave it open.
  if (!shell) {
    return command
  }
  const basename =
    windowsTerminalShell?.trim().replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  if (['cmd', 'cmd.exe', 'wsl', 'wsl.exe'].includes(basename)) {
    return `${command}${SETUP_SUCCESS_EXIT_SUFFIX}`
  }
  // Why: PowerShell is the default and also the fallback when a configured Git Bash is missing.
  return `${command}${POWERSHELL_SETUP_SUCCESS_EXIT_SUFFIX}`
}

/** Honours the "Close setup tab when it succeeds" setting for a command that launches setup. */
export function applySetupAutoCloseSetting(
  command: string,
  platform: SetupRunnerCommandPlatform,
  shell: SetupRunnerShell | undefined,
  settings:
    | Partial<Pick<GlobalSettings, 'closeSetupTabOnSuccess' | 'terminalWindowsShell'>>
    | null
    | undefined
): string {
  return settings?.closeSetupTabOnSuccess === true
    ? appendShellExitOnSetupSuccess(command, platform, shell, settings.terminalWindowsShell)
    : command
}

/** True when the command ends with a clause from {@link appendShellExitOnSetupSuccess}. */
export function exitsShellOnSetupSuccess(command: string | undefined): boolean {
  return (
    command !== undefined &&
    (command.endsWith(SETUP_SUCCESS_EXIT_SUFFIX) ||
      command.endsWith(POWERSHELL_SETUP_SUCCESS_EXIT_SUFFIX))
  )
}
