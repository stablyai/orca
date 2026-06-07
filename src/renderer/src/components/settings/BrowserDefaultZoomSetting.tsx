import {
  BROWSER_PAGE_ZOOM_LEVELS,
  browserPageZoomLevelToPercent,
  normalizeBrowserPageZoomLevel
} from '../../../../shared/browser-page-zoom'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'

type BrowserDefaultZoomSettingProps = {
  value: number
  onChange: (value: number) => void
}

export function BrowserDefaultZoomSetting({
  value,
  onChange
}: BrowserDefaultZoomSettingProps): React.JSX.Element {
  const selectedZoomLevel = normalizeBrowserPageZoomLevel(value)

  return (
    <SearchableSetting
      title="Default Zoom"
      description="Zoom level applied to newly opened browser tabs."
      keywords={['browser', 'zoom', 'scale', 'default', 'page zoom', 'new tab', 'percentage']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>Default Zoom</Label>
        <p className="text-xs text-muted-foreground">Applied to newly opened browser tabs.</p>
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
