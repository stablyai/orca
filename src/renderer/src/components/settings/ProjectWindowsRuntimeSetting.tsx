import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Project, ProjectUpdateArgs } from '../../../../shared/project-types'
import type { LocalWindowsRuntimePreference } from '../../../../shared/project-execution-runtime'
import {
  normalizeProjectRuntimePreference,
  resolveProjectExecutionRuntime
} from '../../../../shared/project-execution-runtime'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { useEffect, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Button } from '../ui/button'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import type { ProjectRuntimeSessionSummary } from './repository-runtime-session-summary'
import { translate } from '@/i18n/i18n'
import {
  getDefaultRuntimeLabel,
  getProjectRuntimeDescription,
  getRuntimeSessionWarning,
  getVisibleDistroOptions,
  getNextProjectWslDistro,
  hasActiveRuntimeSessions,
  sameRuntimePreference
} from './project-runtime-setting-copy'

type ProjectRuntimeSegment = LocalWindowsRuntimePreference['kind']

type ProjectWindowsRuntimeSettingProps = {
  project: Project | null
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>
  isLocalWindowsProject: boolean
  /** Where this project's files live; a WSL UNC pins the runtime to that distro. */
  repoPath?: string | null
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
  repoPath,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading,
  runtimeSessionSummary,
  updateProject
}: ProjectWindowsRuntimeSettingProps): React.JSX.Element | null {
  const [pendingPreference, setPendingPreference] = useState<LocalWindowsRuntimePreference | null>(
    null
  )
  const normalizedLockRef = useRef<string | null>(null)

  // Why locked: storage and execution must agree — a project on
  // \\wsl.localhost\<distro> that ran on the Windows host would push every git
  // and terminal call across 9P. Unlocks when the distro disappears (repair)
  // or WSL goes unavailable (the repair copy's "switch to Windows" must work).
  const storageWslDistro = repoPath ? (parseWslUncPath(repoPath)?.distro ?? null) : null
  const lockedWslDistro =
    storageWslDistro &&
    (wslCapabilitiesLoading || (wslAvailable && wslDistros.includes(storageWslDistro)))
      ? storageWslDistro
      : null
  const lockedPreference = lockedWslDistro
    ? ({ kind: 'wsl', distro: lockedWslDistro } as LocalWindowsRuntimePreference)
    : null

  // Why: legacy projects could carry a non-WSL preference over a WSL UNC path;
  // align the stored preference with the lock instead of displaying a lie.
  useEffect(() => {
    if (!project || !lockedWslDistro) {
      // Why reset: the lock is off (distro gone / WSL unavailable). Clearing the
      // ref lets a later re-engage re-normalize instead of skipping on a stale key.
      normalizedLockRef.current = null
      return
    }
    // Why: the lock overrides any half-made choice — drop a pending change so the
    // Apply/Cancel banner cannot linger over a locked, non-editable control.
    setPendingPreference(null)
    const stored = normalizeProjectRuntimePreference(project.localWindowsRuntimePreference)
    if (stored.kind === 'wsl' && stored.distro === lockedWslDistro) {
      return
    }
    const lockKey = `${project.id}:${lockedWslDistro}`
    if (normalizedLockRef.current === lockKey) {
      return
    }
    normalizedLockRef.current = lockKey
    void updateProject(project.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: lockedWslDistro }
    })
  }, [lockedWslDistro, project, updateProject])

  if (!project || !isLocalWindowsProject) {
    return null
  }

  const preference = normalizeProjectRuntimePreference(project.localWindowsRuntimePreference)
  const selectedPreference = lockedPreference ?? pendingPreference ?? preference
  const nextWslDistro = getNextProjectWslDistro(selectedPreference, settings, wslDistros)
  const resolution = resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: project.id,
    projectRuntimePreference: lockedPreference ?? preference,
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
    // Why: storage pins the runtime while locked, so no commit is accepted —
    // normalization already persisted the locked distro, and this no-op stops a
    // stale pending Apply from writing anything over it.
    if (lockedWslDistro !== null) {
      return
    }
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
    // Why: while locked, storage pins the runtime — a different distro would
    // recreate the storage/execution mismatch the lock exists to prevent.
    if (lockedWslDistro !== null && distro !== lockedWslDistro) {
      return
    }
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
                  label: <span className="whitespace-nowrap">{defaultRuntimeLabel}</span>,
                  disabled: lockedWslDistro !== null
                },
                {
                  value: 'windows-host',
                  label: translate(
                    'auto.components.settings.ProjectWindowsRuntimeSetting.windows',
                    'Windows'
                  ),
                  disabled: lockedWslDistro !== null
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
            {isWslSelected || lockedWslDistro !== null ? (
              <Select
                value={
                  selectedPreference.kind === 'wsl'
                    ? selectedPreference.distro
                    : (lockedWslDistro ?? '')
                }
                onValueChange={handleDistroChange}
                disabled={lockedWslDistro !== null || wslCapabilitiesLoading || !wslAvailable}
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
      {lockedWslDistro !== null ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ProjectWindowsRuntimeSetting.wslStorageLocked',
            'This project is stored inside {{distro}} (\\\\wsl.localhost), so the runtime is locked to that distro. Move the project out of the distro to change it.',
            { distro: lockedWslDistro }
          )}
        </p>
      ) : null}
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
