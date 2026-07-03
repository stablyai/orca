import type { GlobalSettings, Project, ProjectUpdateArgs } from '../../../../shared/types'
import type { LocalWindowsRuntimePreference } from '../../../../shared/project-execution-runtime'
import {
  normalizeProjectRuntimePreference,
  resolveProjectExecutionRuntime
} from '../../../../shared/project-execution-runtime'
import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Button } from '../ui/button'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import type { ProjectRuntimeSessionSummary } from './repository-runtime-session-summary'
import { translate } from '@/i18n/i18n'

type ProjectRuntimeSegment = LocalWindowsRuntimePreference['kind']

type ProjectWindowsRuntimeSettingProps = {
  project: Project | null
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>
  isLocalWindowsProject: boolean
  wslAvailable: boolean
  wslDistros: string[]
  wslCapabilitiesLoading: boolean
  runtimeSessionSummary?: ProjectRuntimeSessionSummary
  updateProject: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
}

export function ProjectWindowsRuntimeSetting({
  project,
  settings,
  isLocalWindowsProject,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading,
  runtimeSessionSummary,
  updateProject
}: ProjectWindowsRuntimeSettingProps): React.JSX.Element | null {
  const [pendingPreference, setPendingPreference] = useState<LocalWindowsRuntimePreference | null>(
    null
  )

  if (!project || !isLocalWindowsProject) {
    return null
  }

  const preference = normalizeProjectRuntimePreference(project.localWindowsRuntimePreference)
  const selectedPreference = pendingPreference ?? preference
  const nextWslDistro = getNextProjectWslDistro(selectedPreference, settings, wslDistros)
  const resolution = resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: project.id,
    projectRuntimePreference: preference,
    globalWindowsRuntimeDefault: settings.localWindowsRuntimeDefault,
    wslAvailable: wslCapabilitiesLoading ? undefined : wslAvailable,
    availableWslDistros: wslCapabilitiesLoading ? null : wslDistros
  })
  const isWslSelected = selectedPreference.kind === 'wsl'
  const distroOptions = getVisibleDistroOptions(selectedPreference, wslDistros)
  const runtimeSessionWarning = getRuntimeSessionWarning(runtimeSessionSummary)
  const hasRuntimeSessions = hasActiveRuntimeSessions(runtimeSessionSummary)
  const hasPendingPreference = pendingPreference !== null
  const defaultRuntimeLabel = getDefaultRuntimeLabel(settings)
  const commitRuntimePreference = (nextPreference: LocalWindowsRuntimePreference): void => {
    setPendingPreference(null)
    if (nextPreference.kind === 'inherit-global') {
      void updateProject(project.id, { localWindowsRuntimePreference: undefined })
      return
    }
    if (nextPreference.kind === 'windows-host') {
      void updateProject(project.id, {
        localWindowsRuntimePreference: { kind: 'windows-host' }
      })
      return
    }
    void updateProject(project.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: nextPreference.distro }
    })
  }
  const requestRuntimePreference = (nextPreference: LocalWindowsRuntimePreference): void => {
    if (sameRuntimePreference(nextPreference, preference)) {
      setPendingPreference(null)
      return
    }
    if (hasRuntimeSessions) {
      setPendingPreference(nextPreference)
      return
    }
    commitRuntimePreference(nextPreference)
  }
  const handleRuntimeChange = (value: ProjectRuntimeSegment): void => {
    if (value === 'inherit-global') {
      requestRuntimePreference({ kind: 'inherit-global' })
      return
    }
    if (value === 'windows-host') {
      requestRuntimePreference({ kind: 'windows-host' })
      return
    }
    if (nextWslDistro) {
      requestRuntimePreference({ kind: 'wsl', distro: nextWslDistro })
    }
  }
  const handleDistroChange = (distro: string): void => {
    requestRuntimePreference({ kind: 'wsl', distro })
  }

  return (
    <section className="space-y-3">
      <SettingsRow
        label={translate(
          'auto.components.settings.ProjectWindowsRuntimeSetting.projectRuntime',
          'Project runtime'
        )}
        alignTop
        description={getProjectRuntimeDescription(resolution)}
        control={
          <div className="flex flex-col items-end gap-2">
            <SettingsSegmentedControl<ProjectRuntimeSegment>
              ariaLabel={translate(
                'auto.components.settings.ProjectWindowsRuntimeSetting.projectRuntime',
                'Project runtime'
              )}
              value={selectedPreference.kind}
              onChange={handleRuntimeChange}
              options={[
                {
                  value: 'inherit-global',
                  label: <span className="whitespace-nowrap">{defaultRuntimeLabel}</span>
                },
                {
                  value: 'windows-host',
                  label: translate(
                    'auto.components.settings.ProjectWindowsRuntimeSetting.windows',
                    'Windows'
                  )
                },
                {
                  value: 'wsl',
                  label: translate(
                    'auto.components.settings.ProjectWindowsRuntimeSetting.wsl',
                    'WSL'
                  ),
                  disabled: wslCapabilitiesLoading || !wslAvailable || !nextWslDistro
                }
              ]}
            />
            {isWslSelected ? (
              <Select
                value={selectedPreference.kind === 'wsl' ? selectedPreference.distro : ''}
                onValueChange={handleDistroChange}
                disabled={wslCapabilitiesLoading || !wslAvailable}
              >
                <SelectTrigger size="sm" className="w-full min-w-52">
                  <SelectValue
                    placeholder={translate(
                      'auto.components.settings.ProjectWindowsRuntimeSetting.selectDistro',
                      'Select distro'
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {distroOptions.map((distro) => (
                    <SelectItem key={distro} value={distro}>
                      {distro}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        }
      />
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.ProjectWindowsRuntimeSetting.runtimeChangeHelp',
          'Runtime changes apply to new terminals, agent checks, and skill discovery for this project. Existing terminals keep their current runtime.'
        )}
      </p>
      {runtimeSessionWarning ? (
        <p className="text-xs text-muted-foreground">{runtimeSessionWarning}</p>
      ) : null}
      {hasPendingPreference ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ProjectWindowsRuntimeSetting.pendingRuntimeChange',
              'Runtime change pending. New project work will use the selected runtime after you apply.'
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPendingPreference(null)}
          >
            {translate('auto.components.settings.ProjectWindowsRuntimeSetting.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              if (pendingPreference) {
                commitRuntimePreference(pendingPreference)
              }
            }}
          >
            {translate(
              'auto.components.settings.ProjectWindowsRuntimeSetting.applyRuntimeChange',
              'Apply runtime change'
            )}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function hasActiveRuntimeSessions(summary?: ProjectRuntimeSessionSummary): boolean {
  return (summary?.liveTerminalCount ?? 0) > 0 || (summary?.activeTaskCount ?? 0) > 0
}

function sameRuntimePreference(
  left: LocalWindowsRuntimePreference,
  right: LocalWindowsRuntimePreference
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  return left.kind !== 'wsl' || left.distro === (right.kind === 'wsl' ? right.distro : null)
}

function joinRuntimeSessionParts(parts: string[]): string {
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

function getRuntimeSessionWarning(summary?: ProjectRuntimeSessionSummary): string | null {
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

function getNextProjectWslDistro(
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

function getVisibleDistroOptions(
  preference: LocalWindowsRuntimePreference,
  wslDistros: readonly string[]
): string[] {
  const options = [...wslDistros]
  if (preference.kind === 'wsl' && !options.includes(preference.distro)) {
    return [preference.distro, ...options]
  }
  return options
}

function getDefaultRuntimeLabel(
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

function getProjectRuntimeDescription(
  resolution: ReturnType<typeof resolveProjectExecutionRuntime>
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
