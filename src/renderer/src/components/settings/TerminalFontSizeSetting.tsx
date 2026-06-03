import { Minus, Plus } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'

export function TerminalFontSizeSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  return (
    <SearchableSetting
      title="Font Size"
      description="Default terminal font size for new panes and live updates."
      keywords={['terminal', 'typography', 'text size']}
    >
      <SettingsRow
        label="Font Size"
        description="Default terminal font size for new panes and live updates."
        control={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => {
                const next = Math.max(10, settings.terminalFontSize - 1)
                updateSettings({ terminalFontSize: next })
              }}
              disabled={settings.terminalFontSize <= 10}
            >
              <Minus className="size-3" />
            </Button>
            <Input
              type="number"
              min={10}
              max={24}
              value={settings.terminalFontSize}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10)
                if (!Number.isNaN(value) && value >= 10 && value <= 24) {
                  updateSettings({ terminalFontSize: value })
                }
              }}
              className="w-14 text-center tabular-nums"
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => {
                const next = Math.min(24, settings.terminalFontSize + 1)
                updateSettings({ terminalFontSize: next })
              }}
              disabled={settings.terminalFontSize >= 24}
            >
              <Plus className="size-3" />
            </Button>
            <span className="text-xs text-muted-foreground">px</span>
          </div>
        }
      />
    </SearchableSetting>
  )
}
