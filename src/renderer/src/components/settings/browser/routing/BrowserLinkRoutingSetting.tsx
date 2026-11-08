import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'

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
  return (
    <SearchableSetting
      title={t('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')}
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
        <Label>{t('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')}</Label>
        <p className="text-xs text-muted-foreground">{linkRoutingDescription}</p>
      </div>
      <Switch
        aria-label={t('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')}
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
