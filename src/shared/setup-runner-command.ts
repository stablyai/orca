import { isWindowsAbsolutePathLike } from './cross-platform-path'

export type SetupRunnerCommandPlatform = 'windows' | 'posix'
export type SetupRunnerShellFamily = 'posix' | 'cmd' | 'powershell'
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
    if (shell?.family === 'posix' || /\.sh$/i.test(runnerScriptPath)) {
      const posixPath = nativeWindowsPathToPosixShellPath(runnerScriptPath)
      return {
        command: `bash ${quotePosixArg(posixPath)}`,
        runnerScriptPathForShell: posixPath,
        shell: 'posix'
      }
    }
    if (shell?.family === 'powershell' || /\.ps1$/i.test(runnerScriptPath)) {
      const executable = shell?.executable?.trim() || 'powershell.exe'
      return {
        command: `${executable} -NoProfile -ExecutionPolicy Bypass -File ${quoteWindowsArg(runnerScriptPath)}`,
        runnerScriptPathForShell: runnerScriptPath,
        shell: 'windows'
      }
    }
    return {
      command: `cmd.exe /c ${quoteWindowsArg(runnerScriptPath)}`,
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

function nativeWindowsPathToPosixShellPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (driveMatch) {
    return `/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
  }
  return value.replace(/\\/g, '/')
}
