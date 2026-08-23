import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { SkillDiscoveryTarget } from '../../../shared/skills'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import { translate } from '@/i18n/i18n'

export type ProjectAgentSkillRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  hostPlatform?: NodeJS.Platform
  terminalWindowsShell?: string | null
  runtimeEnvironmentId?: string | null
  runtimeOwnershipResolved?: boolean
  label: string
}

export function getProjectSkillDiscoveryTarget(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): SkillDiscoveryTarget | undefined {
  return projectRuntime ? { projectRuntime } : undefined
}

export function getProjectAgentSkillRuntime(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  currentPlatform: NodeJS.Platform
): ProjectAgentSkillRuntime | undefined {
  if (!projectRuntime) {
    return undefined
  }

  if (projectRuntime.status === 'repair-required') {
    return getWslAgentSkillRuntime(projectRuntime.repair.preferredRuntime.distro)
  }

  if (projectRuntime.runtime.kind === 'wsl') {
    return getWslAgentSkillRuntime(projectRuntime.runtime.distro)
  }

  return {
    runtime: 'host',
    hostPlatform: currentPlatform,
    runtimeEnvironmentId: null,
    runtimeOwnershipResolved: true,
    label: currentPlatform === 'win32' ? 'Windows' : 'This device'
  }
}

export function getHostAgentSkillRuntime(
  hostPlatform?: NodeJS.Platform,
  terminalWindowsShell?: string | null,
  runtimeEnvironmentId?: string | null
): ProjectAgentSkillRuntime {
  return {
    runtime: 'host',
    hostPlatform,
    ...(terminalWindowsShell !== undefined ? { terminalWindowsShell } : {}),
    ...(runtimeEnvironmentId !== undefined ? { runtimeEnvironmentId } : {}),
    runtimeOwnershipResolved: runtimeEnvironmentId !== undefined,
    label: hostPlatform === 'win32' ? 'Windows' : 'This device'
  }
}

export function getHostFallbackAgentSkillRuntime(
  runtime?: ProjectAgentSkillRuntime
): ProjectAgentSkillRuntime {
  const hostPlatform = runtime?.hostPlatform ?? (runtime?.runtime === 'wsl' ? 'win32' : undefined)
  const runtimeEnvironmentId =
    runtime?.runtimeEnvironmentId !== undefined
      ? runtime.runtimeEnvironmentId
      : runtime?.runtime === 'wsl'
        ? null
        : undefined
  const fallback = getHostAgentSkillRuntime(
    hostPlatform,
    runtime?.terminalWindowsShell,
    runtimeEnvironmentId
  )
  return runtime && 'terminalWindowsShell' in runtime
    ? { ...fallback, terminalWindowsShell: runtime.terminalWindowsShell }
    : fallback
}

export function getProjectAgentSkillTerminalShellOverride(
  currentPlatform: NodeJS.Platform,
  settings: Pick<GlobalSettings, 'terminalWindowsShell'> | null | undefined,
  runtime: ProjectAgentSkillRuntime | undefined
): string | undefined {
  if (currentPlatform !== 'win32') {
    return undefined
  }
  if (runtime?.runtime === 'wsl') {
    return 'powershell.exe'
  }
  // Why: generated skill commands are PowerShell/cmd syntax, so a POSIX-family
  // Windows shell (wsl.exe, Git Bash) would mangle the wrapper we hand it.
  const terminalWindowsShell =
    runtime && 'terminalWindowsShell' in runtime
      ? runtime.terminalWindowsShell
      : settings?.terminalWindowsShell
  return resolveWindowsShellStartupFamily(terminalWindowsShell) === 'posix'
    ? 'powershell.exe'
    : undefined
}

export function getProjectSkillInstallDisabledReason(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): string | null {
  if (projectRuntime?.status !== 'repair-required') {
    return null
  }

  switch (projectRuntime.repair.reason) {
    case 'wsl-unavailable':
      return translate(
        'auto.lib.projectSkillRuntime.wslUnavailable',
        'Project runtime needs WSL before this skill can be installed.'
      )
    case 'wsl-distro-required':
      return translate(
        'auto.lib.projectSkillRuntime.distroRequired',
        'Select a WSL distro for this project before installing this skill.'
      )
    case 'wsl-distro-missing':
      return translate(
        'auto.lib.projectSkillRuntime.distroMissing',
        'The selected WSL distro is unavailable. Choose an available distro or switch this project to Windows.'
      )
  }
}

function getWslAgentSkillRuntime(distro: string | null): ProjectAgentSkillRuntime {
  return {
    runtime: 'wsl',
    wslDistro: distro,
    hostPlatform: 'win32',
    runtimeEnvironmentId: null,
    runtimeOwnershipResolved: true,
    label: distro
      ? `WSL ${distro}`
      : translate('auto.lib.projectSkillRuntime.wslDefault', 'WSL default')
  }
}
