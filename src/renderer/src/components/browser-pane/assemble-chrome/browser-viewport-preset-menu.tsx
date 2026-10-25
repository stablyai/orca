import { Monitor } from 'lucide-react'
import {
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { BROWSER_VIEWPORT_PRESETS } from '../../../../../shared/browser-viewport-presets'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'

export function BrowserViewportPresetMenu({
  viewportPresetId,
  onApplyViewportPreset
}: {
  viewportPresetId: BrowserViewportPresetId | null
  onApplyViewportPreset: (id: BrowserViewportPresetId | null) => void
}): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Monitor className="mr-2 size-3.5" />
        {translate('auto.components.browser.pane.BrowserToolbarMenu.e5d31de1a9', 'Viewport Size')}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>
          {/* Why: Viewport is a "pick one of N" control, so use a radio group
                  for proper a11y semantics (role="menuitemradio", aria-checked).
                  The "Default" option represents a null preset (no override),
                  encoded as the sentinel string 'default' because
                  DropdownMenuRadioGroup values must be strings. */}
          <DropdownMenuRadioGroup
            value={viewportPresetId ?? 'default'}
            onValueChange={(v) =>
              onApplyViewportPreset(
                BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === v)?.id ?? null
              )
            }
          >
            <DropdownMenuRadioItem value="default">
              {translate('auto.components.browser.pane.BrowserToolbarMenu.ed8f54509d', 'Default')}
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {BROWSER_VIEWPORT_PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset.id} value={preset.id}>
                <span className="truncate">{preset.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
