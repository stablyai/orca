import { Minus, Plus } from 'lucide-react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'

export function TerminalFontSizeSetting({
  settings,
  updateSettings,
  forceVisible = false
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const fontSizeLabel = t(
    'auto.components.settings.TerminalFontSizeSetting.a653570abf',
    'Font size'
  )
  return (
    <SearchableSetting
      title={fontSizeLabel}
      description={t(
        'auto.components.settings.TerminalFontSizeSetting.0f4c92e595',
        'Default terminal font size for new panes and live updates.'
      )}
      keywords={['terminal', 'typography', 'text size']}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={fontSizeLabel}
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
              aria-label={t('settings.terminal.fontSize.decrease', 'Decrease font size')}
            >
              <Minus className="size-3" />
            </Button>
            {/* Hide native spinners that overlap values and duplicate the custom steppers. */}
            <Input
              type="number"
              min={10}
              max={24}
              aria-label={fontSizeLabel}
              value={settings.terminalFontSize}
              onChange={(e) => {
                const value = Number.parseInt(e.target.value, 10)
                if (!Number.isNaN(value) && value >= 10 && value <= 24) {
                  updateSettings({ terminalFontSize: value })
                }
              }}
              className="number-input-clean w-14 text-center tabular-nums"
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => {
                const next = Math.min(24, settings.terminalFontSize + 1)
                updateSettings({ terminalFontSize: next })
              }}
              disabled={settings.terminalFontSize >= 24}
              aria-label={t('settings.terminal.fontSize.increase', 'Increase font size')}
            >
              <Plus className="size-3" />
            </Button>
            <span className="text-xs text-muted-foreground">
              {t('auto.components.settings.TerminalFontSizeSetting.9b5252c85a', 'px')}
            </span>
          </div>
        }
      />
    </SearchableSetting>
  )
}
