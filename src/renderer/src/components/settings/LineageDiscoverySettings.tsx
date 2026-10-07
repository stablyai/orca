import React, { useCallback } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_LINEAGE_DISCOVERY,
  type LineageDiscoverySettings as LineageDiscoveryConfig,
  type LineagePatternMatchOn
} from '../../../../shared/lineage-discovery-types'
import { Checkbox } from '../ui/checkbox'
import { Label } from '../ui/label'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { LineagePatternTester } from './LineagePatternTester'
import { SettingsRow, SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'

type LineageDiscoverySettingsProps = {
  settings: Pick<GlobalSettings, 'lineageDiscovery'>
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

type RepoScopeMode = 'all' | 'selected'

export function LineageDiscoverySettings({
  settings,
  updateSettings
}: LineageDiscoverySettingsProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const config: LineageDiscoveryConfig = {
    ...DEFAULT_LINEAGE_DISCOVERY,
    ...settings.lineageDiscovery
  }
  const patternOff = !config.patternEnabled

  const save = useCallback(
    (patch: Partial<LineageDiscoveryConfig>) => {
      void updateSettings({ lineageDiscovery: { ...config, ...patch } })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config is rebuilt each render from these fields
    [updateSettings, settings.lineageDiscovery]
  )
  const saveKeyRegex = useCallback((keyRegex: string) => save({ keyRegex }), [save])

  const scopeMode: RepoScopeMode = config.repoScope === 'all' ? 'all' : 'selected'
  const selectedRepoIds = config.repoScope === 'all' ? [] : config.repoScope

  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold">
        {translate('auto.components.settings.lineageDiscovery.title', 'Fleet / control tower')}
      </h3>
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.lineageDiscovery.followLineage',
          'Follow workspace lineage'
        )}
        description={translate(
          'auto.components.settings.lineageDiscovery.followLineageDescription',
          'Include workspaces created from a control tower in its checks and source control.'
        )}
        checked={config.lineageEnabled}
        onChange={() => save({ lineageEnabled: !config.lineageEnabled })}
      />
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.lineageDiscovery.matchByPattern',
          'Match by name pattern'
        )}
        description={translate(
          'auto.components.settings.lineageDiscovery.matchByPatternDescription',
          'Also include worktrees whose branch or name contains a ticket key from the control tower name.'
        )}
        checked={config.patternEnabled}
        onChange={() => save({ patternEnabled: !config.patternEnabled })}
      />
      <LineagePatternTester
        savedKeyRegex={config.keyRegex}
        disabled={patternOff}
        onValidKeyRegex={saveKeyRegex}
      />
      <SettingsRow
        label={translate('auto.components.settings.lineageDiscovery.matchOn', 'Match on')}
        description={translate(
          'auto.components.settings.lineageDiscovery.matchOnDescription',
          'Where a ticket key must appear for a worktree to match.'
        )}
        control={
          <SettingsSegmentedControl<LineagePatternMatchOn>
            value={config.matchOn}
            onChange={(matchOn) => save({ matchOn })}
            ariaLabel={translate('auto.components.settings.lineageDiscovery.matchOn', 'Match on')}
            size="sm"
            options={[
              {
                value: 'branch',
                label: translate('auto.components.settings.lineageDiscovery.branch', 'Branch'),
                disabled: patternOff
              },
              {
                value: 'worktree-name',
                label: translate(
                  'auto.components.settings.lineageDiscovery.worktreeName',
                  'Worktree name'
                ),
                disabled: patternOff
              },
              {
                value: 'both',
                label: translate('auto.components.settings.lineageDiscovery.both', 'Both'),
                disabled: patternOff
              }
            ]}
          />
        }
      />
      <SettingsRow
        label={translate('auto.components.settings.lineageDiscovery.repoScope', 'Repositories')}
        description={translate(
          'auto.components.settings.lineageDiscovery.repoScopeDescription',
          'Which repositories pattern matching may scan.'
        )}
        control={
          <SettingsSegmentedControl<RepoScopeMode>
            value={scopeMode}
            onChange={(mode) => save({ repoScope: mode === 'all' ? 'all' : selectedRepoIds })}
            ariaLabel={translate(
              'auto.components.settings.lineageDiscovery.repoScope',
              'Repositories'
            )}
            size="sm"
            options={[
              {
                value: 'all',
                label: translate(
                  'auto.components.settings.lineageDiscovery.allRepositories',
                  'All repositories'
                ),
                disabled: patternOff
              },
              {
                value: 'selected',
                label: translate(
                  'auto.components.settings.lineageDiscovery.selectedRepositories',
                  'Selected repositories'
                ),
                disabled: patternOff
              }
            ]}
          />
        }
      />
      {scopeMode === 'selected' ? (
        <div className="flex flex-col gap-1.5 pb-2 pl-1">
          {repos.map((repo) => (
            <div key={repo.id} className="flex items-center gap-2">
              <Checkbox
                id={`lineage-scope-${repo.id}`}
                disabled={patternOff}
                checked={selectedRepoIds.includes(repo.id)}
                onCheckedChange={(checked) =>
                  save({
                    repoScope: checked
                      ? [...selectedRepoIds, repo.id]
                      : selectedRepoIds.filter((id) => id !== repo.id)
                  })
                }
              />
              <Label htmlFor={`lineage-scope-${repo.id}`}>{repo.displayName}</Label>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
