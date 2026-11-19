import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'
import { usesHttpLinkMode } from '@/lib/links/preferences/http-link-mode'
import { BrowserOpenLinksSetting } from './BrowserOpenLinksSetting'

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
  const t = useTranslate()
  // Desktop gets the three-way "Open links" control; the web client keeps this switch.
  if (usesHttpLinkMode()) {
    return <BrowserOpenLinksSetting settings={settings} isMac={isMac} />
  }
  return (
    <SearchableSetting
      title={t('auto.components.settings.BrowserPane.7a366a05e1', 'Link routing')}
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
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="space-y-0.5">
        <Label>{t('auto.components.settings.BrowserPane.7a366a05e1', 'Link routing')}</Label>
        <p className="text-xs text-muted-foreground">{linkRoutingDescription}</p>
      </div>
      <Switch
        aria-label={t('auto.components.settings.BrowserPane.7a366a05e1', 'Link routing')}
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
