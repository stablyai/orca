import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  isCodexSharedServerWarningEnabled,
  isCodexTerminalServerIsolationEnabled
} from '../../../../shared/codex-terminal-server-isolation'
import { CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import {
  getCodexSharedServerWarningDescription,
  getCodexSharedServerWarningTitle,
  getCodexTerminalServerIsolationDescription,
  getCodexTerminalServerIsolationSearchKeywords,
  getCodexTerminalServerIsolationTitle
} from './codex-terminal-server-isolation-copy'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type CodexTerminalServerIsolationSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function CodexTerminalServerIsolationSetting({
  settings,
  updateSettings
}: CodexTerminalServerIsolationSettingProps): React.JSX.Element {
  const title = getCodexTerminalServerIsolationTitle()
  const description = getCodexTerminalServerIsolationDescription()
  const enabled = isCodexTerminalServerIsolationEnabled(settings)
  return (
    <section className="space-y-3">
      <SearchableSetting
        id={CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID}
        title={title}
        description={description}
        keywords={getCodexTerminalServerIsolationSearchKeywords()}
      >
        <SettingsSwitchRow
          label={title}
          description={description}
          checked={enabled}
          onChange={() => void updateSettings({ codexTerminalServerIsolation: !enabled })}
        />
        {/* Why only with isolation on: off means sharing the server is what the user chose. */}
        {enabled ? (
          <SettingsSwitchRow
            label={getCodexSharedServerWarningTitle()}
            description={getCodexSharedServerWarningDescription()}
            checked={isCodexSharedServerWarningEnabled(settings)}
            onChange={() =>
              void updateSettings({
                codexSharedServerWarning: !isCodexSharedServerWarningEnabled(settings)
              })
            }
          />
        ) : null}
      </SearchableSetting>
    </section>
  )
}
