import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isCodexTerminalServerIsolationEnabled } from '../../../../shared/codex-terminal-server-isolation'
import { CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import {
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
      </SearchableSetting>
    </section>
  )
}
