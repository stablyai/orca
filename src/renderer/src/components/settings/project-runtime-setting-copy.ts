import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  LocalWindowsRuntimePreference,
  ProjectExecutionRuntimeResolution
} from '../../../../shared/project-execution-runtime'
import type { ProjectRuntimeSessionSummary } from './repository-runtime-session-summary'
import { translate } from '@/i18n/i18n'

// Pure display/state helpers for ProjectWindowsRuntimeSetting — extracted so the
// component body stays under the file line ratchet.

export function hasActiveRuntimeSessions(summary?: ProjectRuntimeSessionSummary): boolean {
  return (summary?.liveTerminalCount ?? 0) > 0 || (summary?.activeTaskCount ?? 0) > 0
}

export function sameRuntimePreference(
  left: LocalWindowsRuntimePreference,
  right: LocalWindowsRuntimePreference
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  return left.kind !== 'wsl' || left.distro === (right.kind === 'wsl' ? right.distro : null)
}

export function joinRuntimeSessionParts(parts: string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? ''
  }
  return translate(
    'auto.components.settings.ProjectWindowsRuntimeSetting.runtimeSessionJoin',
    '{{value0}} and {{value1}}',
    { value0: parts.slice(0, -1).join(', '), value1: parts.at(-1) }
  )
}

function getLiveTerminalCountLabel(count: number): string {
  return translate(
    count === 1
      ? 'auto.components.settings.ProjectWindowsRuntimeSetting.liveTerminalSingular'
      : 'auto.components.settings.ProjectWindowsRuntimeSetting.liveTerminalPlural',
    count === 1 ? '{{count}} live terminal' : '{{count}} live terminals',
    { count }
  )
}

function getActiveTaskCountLabel(count: number): string {
  return translate(
    count === 1
      ? 'auto.components.settings.ProjectWindowsRuntimeSetting.activeTaskSingular'
      : 'auto.components.settings.ProjectWindowsRuntimeSetting.activeTaskPlural',
    count === 1 ? '{{count}} active task' : '{{count}} active tasks',
    { count }
  )
}

export function getRuntimeSessionWarning(summary?: ProjectRuntimeSessionSummary): string | null {
  const liveTerminalCount = summary?.liveTerminalCount ?? 0
  const activeTaskCount = summary?.activeTaskCount ?? 0
  if (liveTerminalCount === 0 && activeTaskCount === 0) {
    return null
  }

  const parts = [
    liveTerminalCount > 0 ? getLiveTerminalCountLabel(liveTerminalCount) : '',
    activeTaskCount > 0 ? getActiveTaskCountLabel(activeTaskCount) : ''
  ].filter((part) => part.length > 0)

  return translate(
    'auto.components.settings.ProjectWindowsRuntimeSetting.runtimeSessionWarning',
    '{{value0}} will keep running in the current runtime. Let tasks finish or restart terminals before continuing.',
    { value0: joinRuntimeSessionParts(parts) }
  )
}

export function getNextProjectWslDistro(
  preference: LocalWindowsRuntimePreference,
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>,
  wslDistros: readonly string[]
): string | null {
  if (preference.kind === 'wsl') {
    return preference.distro
  }
  const globalDistro =
    settings.localWindowsRuntimeDefault.kind === 'wsl'
      ? settings.localWindowsRuntimeDefault.distro
      : null
  if (globalDistro?.trim()) {
    return globalDistro.trim()
  }
  return wslDistros.find((distro) => distro.trim().length > 0) ?? null
}

export function getVisibleDistroOptions(
  preference: LocalWindowsRuntimePreference,
  wslDistros: readonly string[]
): string[] {
  const options = [...wslDistros]
  if (preference.kind === 'wsl' && !options.includes(preference.distro)) {
    return [preference.distro, ...options]
  }
  return options
}

export function getDefaultRuntimeLabel(
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>
): string {
  const runtimeLabel =
    settings.localWindowsRuntimeDefault.kind === 'wsl'
      ? translate('auto.components.settings.ProjectWindowsRuntimeSetting.wsl', 'WSL')
      : translate('auto.components.settings.ProjectWindowsRuntimeSetting.windows', 'Windows')

  return translate(
    'auto.components.settings.ProjectWindowsRuntimeSetting.defaultRuntime',
    'Default ({{value0}})',
    { value0: runtimeLabel }
  )
}

export function getProjectRuntimeDescription(
  resolution: ProjectExecutionRuntimeResolution
): string {
  if (resolution.status === 'repair-required') {
    if (resolution.repair.reason === 'wsl-unavailable') {
      return translate(
        'auto.components.settings.ProjectWindowsRuntimeSetting.wslUnavailable',
        'WSL is not available. Switch this project to Windows or repair WSL.'
      )
    }
    if (resolution.repair.reason === 'wsl-distro-missing') {
      return translate(
        'auto.components.settings.ProjectWindowsRuntimeSetting.distroMissing',
        '{{value0}} is not installed in WSL. Choose an installed distro or switch this project to Windows.',
        { value0: resolution.repair.preferredRuntime.distro ?? 'WSL' }
      )
    }
    return translate(
      'auto.components.settings.ProjectWindowsRuntimeSetting.distroRequired',
      'Choose a WSL distro or switch this project to Windows.'
    )
  }

  if (resolution.runtime.kind === 'wsl') {
    return resolution.runtime.reason === 'global-default'
      ? translate(
          'auto.components.settings.ProjectWindowsRuntimeSetting.inheritedWsl',
          'No project override. General settings select {{value0}} via WSL.',
          { value0: resolution.runtime.distro }
        )
      : translate(
          'auto.components.settings.ProjectWindowsRuntimeSetting.projectWsl',
          'This project runs in {{value0}} via WSL.',
          { value0: resolution.runtime.distro }
        )
  }

  return resolution.runtime.reason === 'global-default'
    ? translate(
        'auto.components.settings.ProjectWindowsRuntimeSetting.inheritedWindows',
        'No project override. General settings select Windows.'
      )
    : translate(
        'auto.components.settings.ProjectWindowsRuntimeSetting.projectWindows',
        'This project runs on Windows.'
      )
}
