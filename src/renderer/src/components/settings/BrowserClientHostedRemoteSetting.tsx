import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import {
  getBrowserClientHostedRemoteDescription,
  getBrowserClientHostedRemoteTitle
} from './browser-client-hosted-remote-copy'

type BrowserClientHostedRemoteSettingProps = {
  settings: Pick<GlobalSettings, 'browserClientHostedRemoteEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserClientHostedRemoteSetting({
  settings,
  updateSettings
}: BrowserClientHostedRemoteSettingProps): React.JSX.Element {
  const title = getBrowserClientHostedRemoteTitle()
  const description = getBrowserClientHostedRemoteDescription()

  return (
    <SearchableSetting
      id={BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={[
        'browser',
        'remote',
        'client',
        'host',
        'hosted',
        'desktop',
        'webview',
        'placement',
        'render',
        'stream'
      ]}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <SettingsSegmentedControl
            size="sm"
            ariaLabel={title}
            // Why: absent means on — profiles written before the flag existed default to client hosting.
            value={settings.browserClientHostedRemoteEnabled !== false ? 'device' : 'server'}
            onChange={(value) =>
              updateSettings({ browserClientHostedRemoteEnabled: value === 'device' })
            }
            options={[
              {
                value: 'device',
                label: translate('settings.browser.clientHostedRemote.optionDevice', 'This device'),
                tooltip: translate(
                  'settings.browser.clientHostedRemote.optionDeviceTooltip',
                  'Pages render on this desktop, so input and popups behave natively.'
                )
              },
              {
                value: 'server',
                label: translate(
                  'settings.browser.clientHostedRemote.optionServer',
                  'Server (streamed)'
                ),
                tooltip: translate(
                  'settings.browser.clientHostedRemote.optionServerTooltip',
                  'Pages render on the remote server and stream to this device.'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
