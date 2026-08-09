import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { ROOM_IMAGE_ZOOM_PRESETS } from './room-image-preview-zoom'

export function RoomImagePreviewZoomMenu({
  zoomPercent,
  fitSelected,
  onSelect,
  onFit
}: {
  zoomPercent: number
  fitSelected: boolean
  onSelect: (zoomPercent: number) => void
  onFit: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="gap-0.5 px-2 text-muted-foreground tabular-nums"
          aria-label={`${translate('rooms.attachment.zoom', 'Zoom')}: ${zoomPercent}%`}
        >
          {zoomPercent}%
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-28">
        <DropdownMenuRadioGroup value={fitSelected ? 'fit' : String(zoomPercent)}>
          {ROOM_IMAGE_ZOOM_PRESETS.map((preset) => (
            <DropdownMenuRadioItem
              key={preset}
              value={String(preset)}
              className="tabular-nums"
              onSelect={() => onSelect(preset)}
            >
              {preset}%
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="fit" onSelect={onFit}>
            {translate('rooms.attachment.zoomToFit', 'Zoom to fit')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
