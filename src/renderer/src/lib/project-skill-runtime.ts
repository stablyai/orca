// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import type { ProjectExecutionRuntimeResolution } from '../../../shared/execution-host/project-execution-runtime'
import type { SkillDiscoveryTarget } from '../../../shared/skills'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type ProjectAgentSkillRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  label: string
}

export function getProjectSkillDiscoveryTarget(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): SkillDiscoveryTarget | undefined {
  return projectRuntime ? { projectRuntime } : undefined
}

export function getProjectAgentSkillRuntime(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  currentPlatform: NodeJS.Platform,
  t?: Translate
): ProjectAgentSkillRuntime | undefined {
  if (!projectRuntime) {
    return undefined
  }

  if (projectRuntime.status === 'repair-required') {
    return getWslAgentSkillRuntime(projectRuntime.repair.preferredRuntime.distro, t)
  }

  if (projectRuntime.runtime.kind === 'wsl') {
    return getWslAgentSkillRuntime(projectRuntime.runtime.distro, t)
  }

  return {
    runtime: 'host',
    label: currentPlatform === 'win32' ? 'Windows' : 'This device'
  }
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
  // POSIX-family Windows shells (WSL/Git Bash) would mangle generated PowerShell/cmd skill wrappers.
  return resolveWindowsShellStartupFamily(settings?.terminalWindowsShell) === 'posix'
    ? 'powershell.exe'
    : undefined
}

export function getProjectSkillInstallDisabledReason(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  t: Translate = translate
): string | null {
  if (projectRuntime?.status !== 'repair-required') {
    return null
  }

  switch (projectRuntime.repair.reason) {
    case 'wsl-unavailable':
      return t(
        'auto.lib.projectSkillRuntime.wslUnavailable',
        'Project runtime needs WSL before this skill can be installed.'
      )
    case 'wsl-distro-required':
      return t(
        'auto.lib.projectSkillRuntime.distroRequired',
        'Select a WSL distro for this project before installing this skill.'
      )
    case 'wsl-distro-missing':
      return t(
        'auto.lib.projectSkillRuntime.distroMissing',
        'The selected WSL distro is unavailable. Choose an available distro or switch this project to Windows.'
      )
  }
}

function getWslAgentSkillRuntime(
  distro: string | null,
  t: Translate = translate
): ProjectAgentSkillRuntime {
  return {
    runtime: 'wsl',
    wslDistro: distro,
    label: distro ? `WSL ${distro}` : t('auto.lib.projectSkillRuntime.wslDefault', 'WSL default')
  }
}
