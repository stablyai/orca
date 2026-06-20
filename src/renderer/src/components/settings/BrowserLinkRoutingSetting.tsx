import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
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
      <button
        role="switch"
        aria-checked={settings.openLinksInApp}
        onClick={() =>
          updateSettings({
            openLinksInApp: !settings.openLinksInApp,
            openLinksInAppPreferencePrompted: true
          })
        }
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
          settings.openLinksInApp ? 'bg-foreground' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
            settings.openLinksInApp ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </SearchableSetting>
  )
}
