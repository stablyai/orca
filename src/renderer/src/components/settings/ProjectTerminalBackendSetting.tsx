import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings, Project, ProjectUpdateArgs } from '../../../../shared/types'
import { resolveTerminalBackend } from '../../../../shared/terminal-backend'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { ProjectRuntimeSessionSummary } from './repository-runtime-session-summary'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'

type ProjectTerminalBackendSettingProps = {
  project: Project
  hostId: ExecutionHostId
  settings: GlobalSettings
  runtimeSessionSummary?: ProjectRuntimeSessionSummary
  updateProject: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
}

export function ProjectTerminalBackendSetting({
  project,
  hostId,
  settings,
  runtimeSessionSummary,
  updateProject
}: ProjectTerminalBackendSettingProps): React.JSX.Element {
  const [migrationBlocked, setMigrationBlocked] = useState(false)
  const preference = project.terminalBackendPreference ?? 'inherit'
  const activeBackend = resolveTerminalBackend({
    globalDefault: settings.terminalBackendDefault ?? 'orca',
    preference,
    activation: project.terminalBackendByHost?.[hostId]
  })
  const updatePreference = (value: 'inherit' | 'orca' | 'herdr'): void => {
    const target = value === 'inherit' ? settings.terminalBackendDefault : value
    if (
      activeBackend === 'orca' &&
      target === 'herdr' &&
      (runtimeSessionSummary?.liveTerminalCount ?? 0) > 0
    ) {
      setMigrationBlocked(true)
      return
    }
    setMigrationBlocked(false)
    void updateProject(project.id, { terminalBackendPreference: value })
  }

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.ProjectTerminalBackendSetting.title',
          'Terminal backend'
        )}
        description={translate(
          'auto.components.settings.ProjectTerminalBackendSetting.active',
          'Active: {{value0}}',
          {
            value0:
              activeBackend === 'herdr'
                ? translate('auto.components.settings.ProjectTerminalBackendSetting.herdr', 'Herdr')
                : translate('auto.components.settings.ProjectTerminalBackendSetting.orca', 'Orca')
          }
        )}
      />
      <SettingsRow
        label={translate(
          'auto.components.settings.ProjectTerminalBackendSetting.preference',
          'Project preference'
        )}
        description={translate(
          'auto.components.settings.ProjectTerminalBackendSetting.preferenceDescription',
          'Changing an active project requires an explicit migration. Running Orca PTYs block migration to Herdr.'
        )}
        control={
          <SettingsSegmentedControl
            ariaLabel={translate(
              'auto.components.settings.ProjectTerminalBackendSetting.aria',
              'Project terminal backend'
            )}
            value={preference}
            onChange={(value) => updatePreference(value as 'inherit' | 'orca' | 'herdr')}
            options={[
              {
                value: 'inherit',
                label: translate(
                  'auto.components.settings.ProjectTerminalBackendSetting.inherit',
                  'Inherit'
                )
              },
              {
                value: 'orca',
                label: translate(
                  'auto.components.settings.ProjectTerminalBackendSetting.orca',
                  'Orca'
                )
              },
              {
                value: 'herdr',
                label: translate(
                  'auto.components.settings.ProjectTerminalBackendSetting.herdr',
                  'Herdr'
                )
              }
            ]}
          />
        }
      />
      {migrationBlocked ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            (runtimeSessionSummary?.liveTerminalCount ?? 0) === 1
              ? 'auto.components.settings.ProjectTerminalBackendSetting.blockedSingular'
              : 'auto.components.settings.ProjectTerminalBackendSetting.blockedPlural',
            (runtimeSessionSummary?.liveTerminalCount ?? 0) === 1
              ? 'Close the {{count}} live Orca terminal before migrating this project to Herdr.'
              : 'Close the {{count}} live Orca terminals before migrating this project to Herdr.',
            { count: runtimeSessionSummary?.liveTerminalCount ?? 0 }
          )}
        </p>
      ) : null}
    </section>
  )
}
