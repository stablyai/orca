import {
  BROWSER_PAGE_ZOOM_LEVELS,
  browserPageZoomLevelToPercent,
  normalizeBrowserPageZoomLevel
} from '../../../../../shared/browser-page-zoom'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'

type BrowserDefaultZoomSettingProps = {
  value: number
  onChange: (value: number) => void
}

export function BrowserDefaultZoomSetting({
  value,
  onChange
}: BrowserDefaultZoomSettingProps): React.JSX.Element {
  const t = useTranslate()
  const selectedZoomLevel = normalizeBrowserPageZoomLevel(value)

  return (
    <SearchableSetting
      title={t('auto.components.settings.BrowserDefaultZoomSetting.265597101f', 'Default Zoom')}
      description={t(
        'auto.components.settings.BrowserDefaultZoomSetting.siteDefault',
        "Zoom for sites you haven't zoomed."
      )}
      keywords={['browser', 'zoom', 'scale', 'default', 'page zoom', 'site', 'percentage']}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="space-y-0.5">
        <Label>
          {t('auto.components.settings.BrowserDefaultZoomSetting.265597101f', 'Default Zoom')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.BrowserDefaultZoomSetting.siteDefault',
            "Zoom for sites you haven't zoomed."
          )}
        </p>
      </div>
      <Select value={String(selectedZoomLevel)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger className="h-7 w-28 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BROWSER_PAGE_ZOOM_LEVELS.map((level) => (
            <SelectItem key={level} value={String(level)} className="text-xs">
              {browserPageZoomLevelToPercent(level)}%
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SearchableSetting>
  )
}
