import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

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
  return (
    <SearchableSetting
      title={translate('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')}
      description={linkRoutingDescription}
      keywords={[
        'browser',
        'preview',
        'links',
        'localhost',
        'webview',
        'markdown',
        isMac ? 'cmd' : 'ctrl',
        'file',
        'editor'
      ]}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>
          {translate('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')}
        </Label>
        <p className="text-xs text-muted-foreground">{linkRoutingDescription}</p>
      </div>
      <Switch
        aria-label={translate('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')}
        checked={settings.openLinksInApp}
        onCheckedChange={(checked) =>
          updateSettings({
            openLinksInApp: checked,
            openLinksInAppPreferencePrompted: true
          })
        }
      />
    </SearchableSetting>
  )
}
