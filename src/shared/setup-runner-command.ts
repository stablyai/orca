import { quoteCmdDoubleQuoted, quotePosixShellUnlessPlainNoAt } from './shell-argument-quoting'
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
        command: `bash ${quotePosixShellUnlessPlainNoAt(linuxPath)}`,
        runnerScriptPathForShell: linuxPath,
        shell: 'posix'
      }
    }
    if (runnerScriptPath.startsWith('/') && !isWindowsAbsolutePathLike(runnerScriptPath)) {
      return {
        command: `bash ${quotePosixShellUnlessPlainNoAt(runnerScriptPath)}`,
        runnerScriptPathForShell: runnerScriptPath,
        shell: 'posix'
      }
    }
    // Runner extension decides its interpreter; a POSIX terminal still sends batch files to cmd.
    const cmdRunnerFile = isWindowsCmdRunnerPath(runnerScriptPath)
    if (!cmdRunnerFile && (shell?.family === 'posix' || /\.sh$/i.test(runnerScriptPath))) {
      // Why: WSL shells need /mnt/... paths, while Git Bash expects /c/... when replaying deferred setup scripts.
      if (isWslExecutable(shell?.executable)) {
        const wslPath = nativeWindowsPathToWslShellPath(runnerScriptPath)
        return {
          command: `bash ${quotePosixShellUnlessPlainNoAt(wslPath)}`,
          runnerScriptPathForShell: wslPath,
          shell: 'posix'
        }
      }
      // Why: queued setup launches can outlive the process that generated them, so convert native paths before handing off to POSIX shells.
      const posixPath = nativeWindowsPathToPosixShellPath(runnerScriptPath)
      return {
        command: `bash ${quotePosixShellUnlessPlainNoAt(posixPath)}`,
        runnerScriptPathForShell: posixPath,
        shell: 'posix'
      }
    }
    return {
      // Guard hostile cmd path characters and Git Bash’s rewriting of bare /c (#6896) with delayed expansion
      // through PowerShell ProcessStartInfo; retain plain invocation for other cases.
      command:
        shell?.family === 'posix' || windowsRunnerPathNeedsCmdGuard(runnerScriptPath)
          ? buildWindowsCmdRunnerDelayedLaunchCommand(runnerScriptPath)
          : `cmd.exe /c ${quoteCmdDoubleQuoted(runnerScriptPath)}`,
      runnerScriptPathForShell: runnerScriptPath,
      shell: 'windows'
    }
  }

  return {
    command: `bash ${quotePosixShellUnlessPlainNoAt(runnerScriptPath)}`,
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
