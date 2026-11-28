import { Minus, Plus } from 'lucide-react'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_STEP,
  parseTerminalFontSizeInput,
  stepTerminalFontSize
} from './terminal-font-size-steps'

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
                updateSettings({
                  terminalFontSize: stepTerminalFontSize(settings.terminalFontSize, -1)
                })
              }}
              disabled={settings.terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
              aria-label={t('settings.terminal.fontSize.decrease', 'Decrease font size')}
            >
              <Minus className="size-3" />
            </Button>
            {/* Hide native spinners that overlap values and duplicate the custom steppers. */}
            <Input
              type="number"
              min={TERMINAL_FONT_SIZE_MIN}
              max={TERMINAL_FONT_SIZE_MAX}
              step={TERMINAL_FONT_SIZE_STEP}
              aria-label={fontSizeLabel}
              value={settings.terminalFontSize}
              onChange={(e) => {
                const value = parseTerminalFontSizeInput(e.target.value)
                if (value !== null) {
                  updateSettings({ terminalFontSize: value })
                }
              }}
              className="number-input-clean w-14 text-center tabular-nums"
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => {
                updateSettings({
                  terminalFontSize: stepTerminalFontSize(settings.terminalFontSize, 1)
                })
              }}
              disabled={settings.terminalFontSize >= TERMINAL_FONT_SIZE_MAX}
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
