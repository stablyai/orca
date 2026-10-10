import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  GIT_PERFORMANCE_CONFIG_KEYS,
  GIT_PERFORMANCE_CONFIG_VALUES
} from '../../../../shared/git-performance-config-plan'
import {
  normalizeGitTuningMode,
  type GitTuningMode
} from '../../../../shared/git-performance-config-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'
import { GitPerformanceConfigRepoList } from './GitPerformanceConfigRepoList'
import {
  GIT_PERFORMANCE_CONFIG_KEYWORDS,
  GIT_PERFORMANCE_CONFIG_SECTION_ID,
  getGitPerformanceConfigDescription,
  getGitPerformanceConfigFsmonitorTitle,
  getGitPerformanceConfigKeyDescription,
  getGitPerformanceConfigTitle
} from './git-performance-config-copy'

// Git's builtin daemon exists only on macOS and Windows; the host's Git version is checked per repo.
function clientSupportsBuiltinFsmonitor(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return navigator.userAgent.includes('Mac') || navigator.userAgent.includes('Windows')
}

const FSMONITOR_KEY = 'core.fsmonitor'
const RECOMMENDED_KEYS = GIT_PERFORMANCE_CONFIG_KEYS.filter((key) => key !== FSMONITOR_KEY)

export function gitPerformanceConfigMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getGitPerformanceConfigTitle(),
    description: getGitPerformanceConfigDescription(),
    keywords: GIT_PERFORMANCE_CONFIG_KEYWORDS
  })
}

export function GitPerformanceConfigSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getGitPerformanceConfigTitle()
  const description = getGitPerformanceConfigDescription()
  const mode = normalizeGitTuningMode(settings.gitTuning)
  const [refreshSignal, setRefreshSignal] = useState(0)

  // Why await before refreshing: main queues its revert when a setting lands, and the
  // rows' reads must arrive after it to show the reverted state.
  const persistThenRefresh = async (updates: Partial<GlobalSettings>): Promise<void> => {
    await updateSettings(updates)
    setRefreshSignal((value) => value + 1)
  }
  const fsmonitorEnabled = settings.gitTuningFsmonitor === true

  return (
    <SearchableSetting
      id={GIT_PERFORMANCE_CONFIG_SECTION_ID}
      title={title}
      description={description}
      keywords={GIT_PERFORMANCE_CONFIG_KEYWORDS}
      className="max-w-none space-y-3"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<GitTuningMode>
            value={mode}
            onChange={(nextMode) => {
              if (nextMode !== mode) {
                void persistThenRefresh({ gitTuning: nextMode })
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'off',
                label: translate('auto.components.settings.GitPerformanceConfig.off', 'Off')
              },
              {
                value: 'recommended',
                label: translate(
                  'auto.components.settings.GitPerformanceConfig.recommended',
                  'Recommended'
                )
              }
            ]}
          />
        }
      />
      <ul className="space-y-1">
        {RECOMMENDED_KEYS.map((key) => (
          <li key={key} className="text-xs text-muted-foreground">
            <code className="font-mono text-foreground">
              {key}={GIT_PERFORMANCE_CONFIG_VALUES[key]}
            </code>{' '}
            {getGitPerformanceConfigKeyDescription(key)}
          </li>
        ))}
      </ul>
      {mode === 'recommended' && clientSupportsBuiltinFsmonitor() ? (
        <SettingsSwitchRow
          label={getGitPerformanceConfigFsmonitorTitle()}
          description={
            <>
              <code className="font-mono text-foreground">
                {FSMONITOR_KEY}={GIT_PERFORMANCE_CONFIG_VALUES[FSMONITOR_KEY]}
              </code>{' '}
              {getGitPerformanceConfigKeyDescription(FSMONITOR_KEY)}
            </>
          }
          checked={fsmonitorEnabled}
          onChange={() => void persistThenRefresh({ gitTuningFsmonitor: !fsmonitorEnabled })}
        />
      ) : null}
      <GitPerformanceConfigRepoList mode={mode} refreshSignal={refreshSignal} />
    </SearchableSetting>
  )
}
