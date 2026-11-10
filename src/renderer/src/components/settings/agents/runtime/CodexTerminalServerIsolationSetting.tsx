import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  isCodexSharedServerWarningEnabled,
  isCodexTerminalServerIsolationEnabled
} from '../../../../../../shared/codex-terminal-server-isolation'
import { CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID } from '@/components/settings/navigation/settings-navigation-types'
import {
  getCodexSharedServerWarningDescription,
  getCodexSharedServerWarningTitle,
  getCodexTerminalServerIsolationDescription,
  getCodexTerminalServerIsolationSearchKeywords,
  getCodexTerminalServerIsolationTitle
} from './codex-terminal-server-isolation-copy'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

type CodexTerminalServerIsolationSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function CodexTerminalServerIsolationSetting({
  settings,
  updateSettings
}: CodexTerminalServerIsolationSettingProps): React.JSX.Element {
  const t = useTranslate()
  const title = getCodexTerminalServerIsolationTitle(t)
  const description = getCodexTerminalServerIsolationDescription(t)
  const enabled = isCodexTerminalServerIsolationEnabled(settings)
  return (
    <SearchableSetting
      id={CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={getCodexTerminalServerIsolationSearchKeywords(t)}
      // Two independent switches share one search unit, so split them like separate rows.
      className="divide-y divide-border"
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled}
        onChange={() => void updateSettings({ codexTerminalServerIsolation: !enabled })}
      />
      {/* With isolation off, sharing is intentional and needs no warning control. */}
      {enabled ? (
        <SettingsSwitchRow
          label={getCodexSharedServerWarningTitle(t)}
          description={getCodexSharedServerWarningDescription(t)}
          checked={isCodexSharedServerWarningEnabled(settings)}
          onChange={() =>
            void updateSettings({
              codexSharedServerWarning: !isCodexSharedServerWarningEnabled(settings)
            })
          }
        />
      ) : null}
    </SearchableSetting>
  )
}
