import type React from 'react'
import { Minus, Plus } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  clampFileExplorerFontSize,
  DEFAULT_FILE_EXPLORER_FONT_SIZE,
  MAX_FILE_EXPLORER_FONT_SIZE,
  MIN_FILE_EXPLORER_FONT_SIZE
} from '../../../../shared/file-explorer-font-size'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

export function FileExplorerFontSizeSetting({
  settings,
  updateSettings,
  forceVisible = false
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}): React.JSX.Element {
  const fontSize = clampFileExplorerFontSize(
    settings.fileExplorerFontSize ?? DEFAULT_FILE_EXPLORER_FONT_SIZE
  )

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.FileExplorerFontSizeSetting.title',
        'File Explorer Font Size'
      )}
      description={translate(
        'auto.components.settings.FileExplorerFontSizeSetting.description',
        'Font size for file and folder names in the File Explorer, independent of UI zoom.'
      )}
      keywords={['file explorer', 'font', 'size', 'sidebar', 'typography', 'resource manager']}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={translate(
          'auto.components.settings.FileExplorerFontSizeSetting.title',
          'File Explorer Font Size'
        )}
        control={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => {
                updateSettings({
                  fileExplorerFontSize: clampFileExplorerFontSize(fontSize - 1)
                })
              }}
              disabled={fontSize <= MIN_FILE_EXPLORER_FONT_SIZE}
            >
              <Minus className="size-3" />
            </Button>
            <Input
              type="number"
              min={MIN_FILE_EXPLORER_FONT_SIZE}
              max={MAX_FILE_EXPLORER_FONT_SIZE}
              value={fontSize}
              onChange={(e) => {
                const value = Number.parseInt(e.target.value, 10)
                if (!Number.isNaN(value)) {
                  updateSettings({ fileExplorerFontSize: clampFileExplorerFontSize(value) })
                }
              }}
              className="w-14 text-center tabular-nums"
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => {
                updateSettings({
                  fileExplorerFontSize: clampFileExplorerFontSize(fontSize + 1)
                })
              }}
              disabled={fontSize >= MAX_FILE_EXPLORER_FONT_SIZE}
            >
              <Plus className="size-3" />
            </Button>
            <span className="text-xs text-muted-foreground">
              {translate('auto.components.settings.FileExplorerFontSizeSetting.px', 'px')}
            </span>
          </div>
        }
      />
    </SearchableSetting>
  )
}
