import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type BrowserLinkSidePaneSettingProps = {
  settings: Pick<GlobalSettings, 'openLinksInApp' | 'openLinksInSidePane'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLinkSidePaneSetting({
  settings,
  updateSettings
}: BrowserLinkSidePaneSettingProps): React.JSX.Element {
  // Why: placement only exists for links Orca opens itself — with Link Routing
  // off they leave for the system browser, so the switch would do nothing.
  const openLinksInApp = settings.openLinksInApp === true
  const title = translate(
    'auto.components.settings.BrowserLinkSidePaneSetting.7f3c1a9e5d',
    'Open Links Beside'
  )
  const description = openLinksInApp
    ? translate(
        'auto.components.settings.BrowserLinkSidePaneSetting.2b8d4f6c01',
        'Open in-app links in the pane beside the one you clicked from, splitting to the right when there is no pane there yet. Off opens another tab in the current pane.'
      )
    : translate(
        'auto.components.settings.BrowserLinkSidePaneSetting.3c5e7a9b1d',
        'Turn on Link Routing to open links in Orca before choosing where they land.'
      )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['browser', 'links', 'routing', 'pane', 'split', 'side', 'beside', 'tab']}
    >
      {/* Nested under Link Routing: only meaningful once links open in Orca. */}
      <div className="ml-4 border-l border-border pl-4">
        <SettingsSwitchRow
          label={title}
          description={description}
          checked={settings.openLinksInSidePane === true}
          disabled={!openLinksInApp}
          onChange={() =>
            updateSettings({ openLinksInSidePane: settings.openLinksInSidePane !== true })
          }
        />
      </div>
    </SearchableSetting>
  )
}
