import type { GlobalSettings } from '../../../../shared/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { isBrowserTabHostLockedToWorkspace, resolveBrowserTabHost } from '@/lib/browser-tab-host'

type BrowserLinkRoutingSettingProps = {
  settings: GlobalSettings
  linkRoutingDescription: string
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLinkRoutingSetting({
  settings,
  linkRoutingDescription,
  isMac,
  updateSettings
}: BrowserLinkRoutingSettingProps): React.JSX.Element {
  const browserTabHostLockedToWorkspace = isBrowserTabHostLockedToWorkspace()
  const linkRoutingTitle = translate(
    'auto.components.settings.BrowserPane.d3eb69c0aa',
    'Link Routing'
  )
  const browserTabHostTitle = translate(
    'auto.components.settings.BrowserLinkRoutingSetting.6bc91cf705',
    'Browser tab host'
  )
  const browserTabHostDescription = translate(
    'auto.components.settings.BrowserLinkRoutingSetting.dac59e11e7',
    'Choose where new browser tabs and links routed into Orca Browser run.'
  )
  const keywords = [
    'browser',
    'preview',
    'links',
    'host',
    'local',
    'remote',
    'runtime',
    'localhost',
    'webview',
    'markdown',
    isMac ? 'cmd' : 'ctrl',
    'file',
    'editor'
  ]

  return (
    <div className="space-y-4">
      <SearchableSetting
        title={linkRoutingTitle}
        description={linkRoutingDescription}
        keywords={keywords}
      >
        <SettingsSwitchRow
          label={linkRoutingTitle}
          description={linkRoutingDescription}
          checked={settings.openLinksInApp}
          onChange={() =>
            updateSettings({
              openLinksInApp: !settings.openLinksInApp,
              openLinksInAppPreferencePrompted: true
            })
          }
        />
      </SearchableSetting>
      <SearchableSetting
        title={browserTabHostTitle}
        description={browserTabHostDescription}
        keywords={keywords}
      >
        <SettingsRow
          label={browserTabHostTitle}
          description={browserTabHostDescription}
          control={
            <Select
              value={resolveBrowserTabHost(settings.browserTabHost)}
              disabled={browserTabHostLockedToWorkspace}
              onValueChange={(value) =>
                updateSettings({ browserTabHost: value as 'local' | 'workspace' })
              }
            >
              <SelectTrigger size="sm" className="max-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="local">
                  {translate(
                    'auto.components.settings.BrowserLinkRoutingSetting.965d31f368',
                    'This computer'
                  )}
                </SelectItem>
                <SelectItem value="workspace">
                  {translate(
                    'auto.components.settings.BrowserLinkRoutingSetting.50294199ff',
                    'Workspace runtime'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SearchableSetting>
    </div>
  )
}
