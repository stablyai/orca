import { win32 as pathWin32 } from 'node:path'
import { isPowerShellExecutableName } from './powershell-osc133-bootstrap'
import { WINDOWS_GIT_BASH_SHELL } from './windows-terminal-shell'
import { resolveWindowsGitBashShellPath } from './windows-git-bash'
import {
  resolveWindowsPowerShellSpawnChain,
  type WindowsPowerShellResolveOptions
} from './windows-powershell-executable'

const WINDOWS_POWERSHELL_SAFE_MODE_ENV = 'ORCA_WINDOWS_POWERSHELL_SAFE_MODE'

export type WindowsPowerShellImplementation = 'auto' | 'powershell.exe' | 'pwsh.exe'
export type WindowsPowerShellShellFamily =
  | 'powershell.exe'
  | 'pwsh.exe'
  | 'cmd.exe'
  | 'wsl.exe'
  | undefined

export type WindowsTerminalShellPathOptions = {
  shellPath: string
  powerShellImplementation?: WindowsPowerShellImplementation
  pwshAvailable?: boolean | (() => boolean)
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  gitBashExists?: (path: string) => boolean
}

type WindowsPowerShellShellPathOptions = Pick<WindowsPowerShellResolveOptions, 'isRealExecutable'>

function readPathEnv(env: NodeJS.ProcessEnv): string {
  return env.PATH || env.Path || env.path || ''
}

function getEnvWithShellDirectory(env: NodeJS.ProcessEnv, shellPath: string): NodeJS.ProcessEnv {
  if (!pathWin32.isAbsolute(shellPath)) {
    return env
  }
  const shellDir = pathWin32.dirname(shellPath)
  const pathValue = readPathEnv(env)
  return {
    ...env,
    PATH: pathValue ? `${shellDir}${pathWin32.delimiter}${pathValue}` : shellDir
  }
}

export function getWindowsShellBasename(shellPath: string): string {
  return pathWin32.basename(shellPath).toLowerCase()
}

function readPwshAvailability(value: boolean | (() => boolean) | undefined): boolean {
  if (typeof value === 'function') {
    return value()
  }
  return value === true
}

export function getWindowsPowerShellShellFamily(
  shellPath: string
): 'powershell.exe' | 'pwsh.exe' | null {
  const shellName = getWindowsShellBasename(shellPath)
  if (shellName === 'pwsh.exe' || shellName === 'pwsh') {
    return 'pwsh.exe'
  }
  if (shellName === 'powershell.exe' || shellName === 'powershell') {
    return 'powershell.exe'
  }
  return null
}

export function isWindowsPowerShellShellPath(shellPath: string): boolean {
  return isPowerShellExecutableName(getWindowsShellBasename(shellPath))
}

export function shouldLaunchWindowsPowerShellWithoutProfile(
  env?: Record<string, string | undefined>
): boolean {
  return env?.[WINDOWS_POWERSHELL_SAFE_MODE_ENV] === '1'
}

export function shouldProbeWindowsPowerShellAvailability(args: {
  shellFamily: WindowsPowerShellShellFamily
  implementation: WindowsPowerShellImplementation | undefined
}): boolean {
  return (
    args.shellFamily === 'powershell.exe' &&
    (args.implementation === undefined || args.implementation === 'auto')
  )
}

export function resolveEffectiveWindowsPowerShell(args: {
  shellFamily: WindowsPowerShellShellFamily
  implementation: WindowsPowerShellImplementation | undefined
  pwshAvailable: boolean
}): 'powershell.exe' | 'pwsh.exe' | null {
  if (args.shellFamily === 'pwsh.exe') {
    return 'pwsh.exe'
  }

  if (args.shellFamily !== 'powershell.exe') {
    return null
  }

  if (args.implementation === 'powershell.exe') {
    return 'powershell.exe'
  }

  if (args.implementation === 'pwsh.exe') {
    return 'pwsh.exe'
  }

  return args.pwshAvailable ? 'pwsh.exe' : 'powershell.exe'
}

export function resolveWindowsPowerShellShellPath(
  shellPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsPowerShellShellPathOptions = {}
): string | null {
  const family = getWindowsPowerShellShellFamily(shellPath)
  if (!family) {
    return null
  }
  const resolveEnv = getEnvWithShellDirectory(env, shellPath)
  const chain = resolveWindowsPowerShellSpawnChain(family, {
    env: resolveEnv,
    platform: 'win32',
    ...(options.isRealExecutable ? { isRealExecutable: options.isRealExecutable } : {})
  })
  return chain[0] ?? null
}

export function resolveWindowsTerminalShellPath(args: WindowsTerminalShellPathOptions): string {
  const platform = args.platform ?? process.platform
  const env = args.env ?? process.env
  const resolvedGitBashPath = resolveWindowsGitBashShellPath(args.shellPath, {
    env,
    platform,
    ...(args.gitBashExists ? { exists: args.gitBashExists } : {})
  })
  if (resolvedGitBashPath) {
    return resolvedGitBashPath
  }
  const shellPath = args.shellPath === WINDOWS_GIT_BASH_SHELL ? 'powershell.exe' : args.shellPath

  const basename = getWindowsShellBasename(shellPath)
  const normalizedShellFamily: WindowsPowerShellShellFamily =
    getWindowsPowerShellShellFamily(shellPath) ??
    (basename === 'cmd.exe' || basename === 'cmd'
      ? 'cmd.exe'
      : basename === 'wsl.exe' || basename === 'wsl'
        ? 'wsl.exe'
        : undefined)
  const shouldResolvePowerShellFamily =
    args.powerShellImplementation !== undefined || pathWin32.basename(shellPath) === shellPath
  if (!shouldResolvePowerShellFamily) {
    return shellPath
  }
  const shouldProbePwsh = shouldProbeWindowsPowerShellAvailability({
    shellFamily: normalizedShellFamily,
    implementation: args.powerShellImplementation
  })
  return (
    resolveEffectiveWindowsPowerShell({
      shellFamily: normalizedShellFamily,
      implementation: args.powerShellImplementation,
      pwshAvailable: shouldProbePwsh ? readPwshAvailability(args.pwshAvailable) : false
    }) ?? shellPath
  )
}
